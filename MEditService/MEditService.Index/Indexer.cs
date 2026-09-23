using System.Diagnostics;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index;

/// <summary>ADR-0014 invariant 5: the Index's other half. Ingest, the registration sweep and the
/// watchers' re-projections, deciding nothing — the load order value answers who participates and
/// wins, the schema where a field goes.</summary>
public sealed class Indexer : IQueryIndex, IRefreshIndex, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger _logger;
    private readonly DuckDbRecordIndexFactory _indexFactory;
    private readonly IPluginAdapter _adapter;
    // Null in every test that does not care, matching DuckDbRecordIndex's own posture.
    private readonly INotificationPublisher? _notifications;
    private readonly SchemaReflector _schemaReflector;
    private readonly TimeProvider _timeProvider;
    // ADR-0013 invariant 4: the one load order, the kernel's. The indexer reads it for who
    // participates and for a copy's mod folder; it never writes it and keeps no view of its own.
    private readonly LoadOrderHolder _holder;
    private HeldPlugins? _heldPlugins;
    private IRecordIndex? _index;
    // Dropped with the scope it was materialized against (see DisposeCurrent): a filter names
    // tables a freshly opened store has no _filter for.
    private string? _filterSql;
    // The reconcile's own progress. Guarded by _lock like _heldPlugins/_index — written by
    // the reconciling thread as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<IndexedPlugin> _indexed = [];
    private bool _conflictsComputed;
    private int _plannedCount;
    // Set only by the reconcile door's own catch, cleared at the top of every attempt: a repeated
    // refusal re-sets it a moment later, a successful one leaves it clear.
    private string? _heldElsewhereMessage;
    // The same lifetime as _heldElsewhereMessage, for the reconcile's other known-unknown outcome.
    private string? _failureMessage;
    // The version the reconcile door last finished answering for — never a superseded attempt's,
    // since that one returns before reaching its own update.
    private long _version;

    /// <summary>The composition root's door: the Index opens its own store, so nothing outside this
    /// project names the store, its factory or how a file is opened (ADR-0014 invariant 5).</summary>
    public Indexer(
        LoadOrderHolder holder,
        IPluginAdapter adapter,
        SchemaReflector schemaReflector,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null)
    {
        _holder = holder;
        _adapter = adapter;
        _schemaReflector = schemaReflector;
        _notifications = notifications;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _logger = loggerFactory?.CreateLogger<Indexer>() ?? NullLogger<Indexer>.Instance;
        _indexFactory = new DuckDbRecordIndexFactory(
            schemaReflector, new TableDdlBuilder(schemaReflector), notifications,
            loggerFactory?.CreateLogger<DuckDbRecordIndexFactory>(), timeProvider);
    }

    // ADR-0013 invariant 4: a copy that failed to open stays a row in an error state until its
    // bytes change. The hash recorded alongside it is what changing detects.
    private readonly Dictionary<PluginCopyKey, string?> _failedHashes = new(PluginCopyKey.Comparer);

    // Two mechanisms, because one is not enough: the token asks the reconcile loop to stop, the
    // exclusive lock waits until it has. Cancelling without draining would let a teardown dispose
    // the DuckDB connection mid-write, a native crash.

    // Deliberately not _lock: the reconciling thread takes _lock on every plugin, so a waiter
    // holding it could never be signalled.
    private readonly Lock _exclusive = new();
    private CancellationTokenSource? _reconcileCancellation;
    private bool _disposed;

    // Takes the exclusive right to reconcile or tear down, waiting out any in-flight reconcile.
    // Always paired with ExitExclusive in a finally.
    private void EnterExclusive()
    {
        // Cancel and dispose both happen under _lock, so a token can never be cancelled after it has
        // been disposed.
        lock (_lock) _reconcileCancellation?.Cancel();
        _exclusive.Enter();
    }

    private void ExitExclusive() => _exclusive.Exit();

    private GameRelease _gameRelease;

    /// <summary>Whether the store registers this copy — an endpoint's 404 question, answered without
    /// handing out the store.</summary>
    public bool Registers(PluginCopyKey key)
    {
        lock (_lock) return _index?.RegisteredPlugins().Contains(key, PluginCopyKey.Comparer) == true;
    }

    // ADR-0009 invariant 4: the hash the store's rows for this copy were built from, or null when
    // it holds no validated rows for it.
    private string? IndexedContentHash(PluginCopyKey key)
    {
        lock (_lock) return _index?.IndexedContentHash(key);
    }

    private static string? ContentHashOnDisk(string pluginPath) => PluginBinaryHash.OfFile(pluginPath);

    /// <summary>One per indexer, never replaced — a reconcile swaps the store underneath it, which
    /// is when the ordering matters most. By construction the outer of the two locks: taking
    /// <c>_lock</c> first and then waiting here would deadlock.</summary>
    public IndexWriteGate WriteGate { get; } = new();

    public bool Closed => Status.State is LoadOrderState.None;

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: before the first reconcile
    /// the Index has opened no store to read.</summary>
    public IRecordReads RequireReads() => RequireScopeCore().Index.At(RecordRef.Effective);

    // The concrete HeldPlugins and write-capable IRecordIndex the projection methods need, wider
    // than the reads the public method hands out. One lock, one null check, one message.
    private (HeldPlugins Held, IRecordIndex Index) RequireScopeCore()
    {
        lock (_lock)
        {
            if (_heldPlugins is not { } held || _index is not { } index)
                throw new NoLoadOrderException();
            return (held, index);
        }
    }

    /// <summary>Assembled from live state rather than cached, so it cannot drift from the reconcile
    /// it describes; failures come straight off the held copies' own list rather than a second place
    /// that could disagree (ADR-0013 invariant 4).</summary>
    public LoadOrderStatus Status
    {
        get
        {
            lock (_lock)
            {
                // Whatever this attempt still holds — usually nothing, since the two known
                // refusals throw before EnsureScope holds anything new — with State/Message
                // overlaid rather than discarded, so a mid-reconcile unknown failure keeps
                // reporting what had already landed.
                LoadOrderStatus held;
                if (_heldPlugins is null)
                {
                    held = LoadOrderStatus.None with { Version = _version };
                }
                else
                {
                    var state = _conflictsComputed ? LoadOrderState.Ready : LoadOrderState.Reconciling;
                    held = new LoadOrderStatus(state, _plannedCount, [.. _indexed], _conflictsComputed, _heldPlugins.Failures, Version: _version);
                }

                if (_heldElsewhereMessage is { } heldElsewhere)
                    return held with { State = LoadOrderState.HeldElsewhere, Message = heldElsewhere };
                if (_failureMessage is { } failure)
                    return held with { State = LoadOrderState.Failed, Message = failure };
                return held;
            }
        }
    }

    // ADR-0015 invariant 3: every site that changes what Status reports calls this after. _lock is
    // reentrant (see ReapplyFilter), so this is safe to call from inside a lock a caller already
    // holds.
    private void PublishStatus() => _notifications?.Publish(new LoadOrderStatusNotification(Status));

    public long Sequence { get { lock (_lock) return _index?.Sequence ?? 0; } }

    /// <summary>ADR-0015 invariant 3: everything projected inside the scope advances the sequence
    /// once, when the outermost of any nested scopes closes. A no-op with no store held.</summary>
    public IDisposable BeginProjection()
    {
        lock (_lock) return _index?.BeginProjection() ?? IndexStore.NoProjectionScope;
    }

    /// <summary>Runs <paramref name="publish"/> once the projection it was raised in has landed, so
    /// nothing names a sequence the store has not reached. Runs at once with no store held.</summary>
    public void Announce(Action publish)
    {
        IRecordIndex? index;
        lock (_lock) index = _index;
        if (index is null) publish();
        else index.Announce(publish);
    }

    // ADR-0015 invariant 3: a whole copy re-derived or removed has too many rows to name, so the
    // announcement names the copy and the sequence the store reached once the projection landed.
    private void AnnouncePluginChanged(IRecordIndex index, PluginCopyKey key) =>
        index.Announce(() => _notifications?.Publish(new PluginChangedNotification(key, index.Sequence)));

    // Polling, not the notification port: this answers one caller's own bound, not every
    // subscriber, and every write already serializes through IndexWriteGate, so a short poll
    // answers within one interval of landing.
    private static readonly TimeSpan SequencePollInterval = TimeSpan.FromMilliseconds(20);

    /// <summary>Polls <see cref="Sequence"/> until it reaches <paramref name="atLeast"/> or
    /// <paramref name="timeout"/> elapses on the injected clock. True the moment it lands; false,
    /// never a throw, on a timeout: the answer is "not yet".</summary>
    public async Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout)
    {
        var deadline = _timeProvider.GetUtcNow() + timeout;
        while (true)
        {
            if (Sequence >= atLeast) return true;
            var remaining = deadline - _timeProvider.GetUtcNow();
            if (remaining <= TimeSpan.Zero) return false;
            await Task.Delay(remaining < SequencePollInterval ? remaining : SequencePollInterval, _timeProvider).ConfigureAwait(false);
        }
    }

    /// <summary>ADR-0013 invariant 1's one verb, on the caller's thread: registrations made equal to
    /// the snapshot, never-held copies indexed, one winner sweep. Every outcome becomes status data,
    /// published once <paramref name="version"/> is answered.</summary>
    public void Reconcile(LoadOrderSnapshot snapshot, long version)
    {
        try
        {
            ReconcileOrRefuse(snapshot);
        }
        catch (OperationCanceledException)
        {
            // Superseded: the reconcile that cancelled this one answers for this version or
            // higher, so nothing here is ever the last word for it.
            return;
        }
        catch (IndexHeldElsewhereException ex)
        {
            lock (_lock) _heldElsewhereMessage = ex.Message;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // ReconcileOrRefuse already logged this at error; there is nothing further up to raise
            // it to, so it becomes status data instead of only a log line.
            lock (_lock) _failureMessage = ex.Message;
        }
        // Max, not assign: the exclusive lock is released before this runs, so a newer version's
        // own stamp can land first, and this one must never answer for it downward.
        lock (_lock) _version = Math.Max(_version, version);
        PublishStatus();
    }

    // A superseded reconcile throws OperationCanceledException, leaving its work for its
    // successor; a second window's hold throws IndexHeldElsewhereException.
    private void ReconcileOrRefuse(LoadOrderSnapshot snapshot)
    {
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Reconciling load order. GameDir={GameDir} Instance={Instance} Plugins={Count} Game={Game}",
                snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.Copies.Count, snapshot.GameRelease);
        }

        // A fresh attempt starting: whatever the previous attempt's own refusal set is stale the
        // moment this one is asked for, whichever way this one goes.
        lock (_lock) { _heldElsewhereMessage = null; _failureMessage = null; }

        EnterExclusive();
        try
        {
            var token = BeginReconcile();
            var (held, index) = EnsureScope(snapshot);
            ReconcileProgressively(held, index, snapshot, token);
        }
        catch (OperationCanceledException ex)
        {
            // Superseded: whatever landed stays held and registered, and the reconcile that
            // cancelled this one owns the rest. Normal, not a failure — Information, not Warning.
            _logger.LogInformation(ex, "Load order reconcile was superseded before it completed");
            throw;
        }
        catch (IndexHeldElsewhereException ex)
        {
            // Refused, not failed — the user has two windows on one instance, and nothing is
            // held here (EnsureScope tore the previous scope down before the open that refused).
            _logger.LogWarning(ex, "Load order refused: the index at {Path} is held by another window", ex.IndexPath);
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Load order reconcile failed");
            throw;
        }
        finally
        {
            EndReconcile();
            ExitExclusive();
        }
    }

    // Called with the exclusive right held, so no other reconcile can be in flight.
    private CancellationToken BeginReconcile()
    {
        var cts = new CancellationTokenSource();
        lock (_lock) _reconcileCancellation = cts;
        return cts.Token;
    }

    private void EndReconcile()
    {
        lock (_lock)
        {
            var cts = _reconcileCancellation;
            _reconcileCancellation = null;
            cts?.Dispose();
        }
    }

    // ADR-0009 invariant 3: the index's home is the MO2 instance — one persistent file per
    // instance, so a fresh open finds whatever the last run left there, and `origin` (a mod folder
    // name) is unique only within one.

    // Published before any plugin is opened, which is what makes the reconcile progressive.
    private (HeldPlugins Held, IRecordIndex Index) EnsureScope(LoadOrderSnapshot snapshot)
    {
        lock (_lock)
        {
            if (_heldPlugins is { } current && _index is { } index && SameScope(current, snapshot))
                return (current, index);
            DisposeCurrent();
        }

        _logger.LogDebug("Initializing DuckDB record index");
        var createTimer = Stopwatch.StartNew();
        var fresh = _indexFactory.Create(snapshot.GameRelease, snapshot.InstanceRoot);
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("DuckDB record index initialized in {ElapsedMs} ms", createTimer.ElapsedMilliseconds);
        }
        var held = new HeldPlugins(
            _adapter, snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.GameRelease, _logger);
        fresh.ReadOpenedCopiesFrom(() => held.OpenedCopies);

        lock (_lock)
        {
            _indexed.Clear();
            _failedHashes.Clear();
            _conflictsComputed = false;
            _plannedCount = 0;
            _heldPlugins = held;
            _index = fresh;
            _gameRelease = snapshot.GameRelease;
        }
        PublishStatus();
        return (held, fresh);
    }

    private static bool SameScope(HeldPlugins held, LoadOrderSnapshot snapshot) =>
        held.GameRelease == snapshot.GameRelease
        && SamePath(held.DataFolderPath, snapshot.DataFolderPath)
        && (held.InstanceRoot, snapshot.InstanceRoot) switch
        {
            (null, null) => true,
            ({ } a, { } b) => SamePath(a, b),
            _ => false,
        };

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

    // The diff is computed first and without side effects — one stamp read and a folder probe per
    // copy — so a snapshot that moves nothing writes nothing and publishes no status.

    // Registrations the snapshot has stopped naming are dropped before anything new is opened, so a
    // freshly opened index file's last-run rows stop answering as early as possible.
    private void ReconcileProgressively(
        HeldPlugins held, IRecordIndex index, LoadOrderSnapshot snapshot, CancellationToken token)
    {
        var resolved = snapshot.Copies;
        var wanted = resolved.ToDictionary(r => r.Key, PluginCopyKey.Comparer);
        var open = held.Plugins.ToDictionary(p => p.Key, PluginCopyKey.Comparer);

        IReadOnlyList<PluginCopyKey> failed;
        lock (_lock) failed = [.. _failedHashes.Keys];
        // Registered, held, or held only as a failure row — a copy the snapshot has stopped naming
        // leaves by every one of those doors, so a stale error row cannot outlive its copy.
        var leaving = index.RegisteredPlugins()
            .Concat(held.Plugins.Select(p => p.Key))
            .Concat(failed)
            .Where(k => !wanted.ContainsKey(k))
            .Distinct(PluginCopyKey.Comparer)
            .ToList();
        var moved = resolved
            .Where(r => open.TryGetValue(r.Key, out var h) && h.Registration != r.Registration)
            .ToList();
        // A copy in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !open.ContainsKey(r.Key) && !StillFailing(r)).ToList();
        // ADR-0007 invariant 3: which truth a copy reads is its folder's answer, and the stamp
        // records the one its rows came from. Tracking and untracking move the first alone, and no
        // load-order difference above names them.
        var stampedFromSource = index.At(RecordRef.Effective).GetTrackedCopies();
        var reDerived = resolved
            .Where(r => open.ContainsKey(r.Key)
                        && SourceIngest.HoldsTree(r.Origin, r.Path, r.Name) != stampedFromSource.Contains(r.Key))
            .ToList();

        bool conflictsComputed;
        lock (_lock) conflictsComputed = _conflictsComputed;
        if (leaving.Count == 0 && moved.Count == 0 && arriving.Count == 0 && reDerived.Count == 0 && conflictsComputed)
        {
            _logger.LogDebug("Load order snapshot is identical to what is held; nothing to reconcile");
            return;
        }

        lock (_lock)
        {
            _conflictsComputed = false;
            _plannedCount = resolved.Count;
        }
        // Reconciling begins here, with the total known — the first status a subscriber sees for
        // this reconcile.
        PublishStatus();

        foreach (var key in leaving)
        {
            index.Unregister(key);
            held.Remove(key);
            lock (_lock)
            {
                _indexed.RemoveAll(i => PluginCopyKey.Comparer.Equals(new PluginCopyKey(i.Name, i.Origin), key));
                _failedHashes.Remove(key);
            }
        }
        if (leaving.Count > 0) PublishStatus();

        foreach (var plugin in moved)
        {
            // ADR-0009 invariant 1: a reorder, an enable, a change of which copy wins — all the
            // same SQL-only move: no re-read, no re-index, so it is safe to apply live and
            // unprompted.
            var metadata = held.Update(open[plugin.Key], plugin.Registration);
            index.Register(metadata.Key, metadata.Registration);
        }

        ReDeriveMovedTruths(held, index, reDerived, token);

        // Two distinct numbers — time to the first queryable plugin (the tree becomes usable) and
        // time to the winner sweep completing. Measured here rather than client-side, where the
        // 500 ms status poll caps the resolution.
        var timer = Stopwatch.StartNew();
        long? firstUsableMs = null;

        // One at a time: opening the whole set first would cost the same total time but make every
        // plugin wait on the slowest before any could be indexed, and bury each open failure.
        foreach (var plugin in arriving)
        {
            // At the top of each plugin rather than mid-plugin: a plugin's ingest is several
            // transactions, so abandoning it partway would leave some committed and others not.
            token.ThrowIfCancellationRequested();

            if (held.Open(plugin) is not { } metadata)
            {
                lock (_lock) _failedHashes[plugin.Key] = PluginBinaryHash.OfFile(plugin.Path);
                continue;
            }
            lock (_lock) _failedHashes.Remove(plugin.Key);

            RegisterOrIndex(held, index, metadata, token);
            firstUsableMs ??= timer.ElapsedMilliseconds;
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0013
        // invariant 1).
        _logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        index.UpdateWinners(snapshot.Participating);
        lock (_lock) _conflictsComputed = true;
        // Ready itself publishes from the reconcile door, once this version is stamped in.
        ReapplyFilter();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Load order reconciled in {TotalMs} ms: {Arrived} arrived, {Moved} moved, {Left} left, {Held} held (first plugin usable after {FirstUsableMs} ms, winner sweep {WinnersMs} ms)",
                timer.ElapsedMilliseconds, arriving.Count, moved.Count, leaving.Count, held.Plugins.Count,
                firstUsableMs, winnersTimer.ElapsedMilliseconds);
        }
    }

    // A copy whose folder was tracked or untracked since it was indexed. Nothing here has compared
    // the two truths, so the copy is re-derived whole from the one its folder now offers.
    private void ReDeriveMovedTruths(
        HeldPlugins held, IRecordIndex index, IReadOnlyList<RegisteredCopy> copies, CancellationToken token)
    {
        foreach (var plugin in copies)
        {
            token.ThrowIfCancellationRequested();
            if (held.Find(plugin.Key) is not { } metadata) continue;

            var holdsTree = SourceIngest.HoldsTree(plugin.Origin, plugin.Path, plugin.Name);
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) now reads from {Truth}; re-deriving it", plugin.Name, plugin.Origin,
                    holdsTree ? "its source tree" : "its binary");
            }
            IndexOnePlugin(held, index, metadata, holdsTree, token);
        }
    }

    // Registers first: the index's reads are scoped by registration, so validate would otherwise
    // compare an empty row set against a full tree. False falls through to a full index.
    private bool WarmRegister(IRecordIndex index, PluginMetadata plugin, bool holdsTree)
    {
        index.Register(plugin.Key, plugin.Registration);

        // An untracked copy's binary was already hashed against its stored claim when the index file
        // opened (IndexStore.ValidateAgainstDisk), so a second hash of every binary here would pay
        // that whole cost twice for no new answer.
        if (!holdsTree) return true;

        try
        {
            var report = index.Validate(plugin.Key, LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path));
            foreach (var failure in report.Failures)
                _logger.LogWarning("Validating {Plugin} at load: {Failure}", plugin.Name, failure);
            return !report.NeedsRebuild;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException
            or NotSupportedException)
        {
            // A tree that cannot be read is no evidence the rows are still true, and the ingest below
            // reports its own failure properly (a source read is never degraded to the binary silently).
            _logger.LogWarning(ex, "Could not validate {Plugin}'s source tree at load; re-deriving it", plugin.Name);
            return false;
        }
    }

    // While the bytes are unchanged the error state stands, and the parse is not paid again.
    private bool StillFailing(RegisteredCopy plugin)
    {
        string? failedAt;
        lock (_lock)
        {
            if (!_failedHashes.TryGetValue(plugin.Key, out failedAt)) return false;
        }
        return failedAt != null && PluginBinaryHash.OfFile(plugin.Path) == failedAt;
    }

    // ADR-0009 invariant 4: a copy the store has seen, still matching the disk, is registered, not
    // indexed; ADR-0015 invariant 4 validates a tracked copy by content on that same warm path.
    // True when the copy answers reads afterwards.
    private bool RegisterOrIndex(HeldPlugins held, IRecordIndex index, PluginMetadata plugin, CancellationToken token)
    {
        var key = plugin.Key;
        var holdsTree = SourceIngest.HoldsTree(plugin.Origin, plugin.Path, plugin.Name);
        if (index.IndexedContentHash(key) != null && WarmRegister(index, plugin, holdsTree))
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Registering {Plugin} ({RecordCount} records), already indexed and unchanged on disk",
                    plugin.Name, plugin.RecordCount);
            }
            // Counted exactly as an indexed plugin is: Status promises a plugin listed here is
            // wholly queryable, and a registered one is.
            lock (_lock) _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
            PublishStatus();
            return true;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
        }
        var indexTimer = Stopwatch.StartNew();
        try
        {
            // ADR-0012: threads the origin into the index, so the DuckDB row is identified
            // by (origin, plugin) together, not filename alone.
            IndexOnePlugin(held, index, plugin, holdsTree, token);
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Indexed {Plugin} in {ElapsedMs} ms", plugin.Name, indexTimer.ElapsedMilliseconds);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // A single plugin with malformed record data must not abort the whole reconcile. Index()
            // runs in its own DuckDB transaction, so the rollback on throw leaves no partial rows.
            _logger.LogWarning(ex, "Failed to index {Plugin}; its records will not be queryable", plugin.Name);
            held.SetFailure(key, PluginLoadFailure.ReasonFor(ex));
            PublishStatus();
            return false;
        }

        lock (_lock)
        {
            // Recorded only once Index() has returned: Status promises a plugin here is wholly
            // queryable, so listing it any earlier would be the partial-visibility lie in a
            // different form.
            _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
        }
        PublishStatus();
        return true;
    }

    // Where a plugin's records come from (ADR-0007 invariant 3): a tracked plugin's source tree,
    // the binary for everything else. Both branches end in the same Index call, keeping the read
    // model free of a dialect.

    // The binary is still read for a tracked plugin — HeldPlugins asks the adapter for its metadata.
    // What this establishes is only "never consult the binary for a tracked plugin's content".

    // A failed source read degrades to the binary, but records a real PluginLoadFailure: a silent
    // fallback would leave the user reading pre-Track binary content believing it was their source.
    private void IndexOnePlugin(
        HeldPlugins held, IRecordIndex index, PluginMetadata plugin,
        bool holdsTree, CancellationToken token)
    {
        // One advance for the whole copy, whichever door it came through (ADR-0015 invariant 3).
        using var _ = index.BeginProjection();

        if (!holdsTree)
        {
            IndexFromBinary(held, index, plugin);
            return;
        }

        try
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Ingesting {Plugin} from its source tree", plugin.Name);
            }
            var modFolder = LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path)
                ?? throw new InvalidOperationException(
                    $"'{plugin.Name}' from '{plugin.Origin}' holds a source tree, so it cannot be the game's own Data directory.");
            SourceIngest.Ingest(
                index, modFolder,
                plugin.Registration, plugin.Key, plugin.Path, held.GameRelease,
                _schemaReflector, _logger, token);
            return;
        }
        catch (OperationCanceledException)
        {
            // The reconcile is being superseded; this is not a source failure and must not be
            // reported as one, nor absorbed into a fallback that would keep working after the cancel.
            throw;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Deliberately every other exception, not a curated set: reading a folder tree through
            // a third-party deserializer fails in open-ended ways, and a curated list would drop the
            // first mode that isn't on it.
            _logger.LogWarning(ex,
                "Could not ingest {Plugin} from its source tree; falling back to the binary", plugin.Name);
            held.SetFailure(plugin.Key,
                $"Could not read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Showing the " +
                "compiled binary instead — edits made since the last compile are not reflected.");
        }

        IndexFromBinary(held, index, plugin);
    }

    // ADR-0005 rule 2: the binary reaches the index as documents, through the adapter's own door,
    // never as a mod this side holds.
    private void IndexFromBinary(HeldPlugins held, IRecordIndex index, PluginMetadata plugin)
    {
        using var documents = OpenDocuments(plugin, held.GameRelease, held.DataFolderPath);
        index.Index(documents, plugin.Registration, plugin.Key, plugin.Path, DerivedFrom.Binary);
    }

    private IPluginDocuments OpenDocuments(PluginMetadata plugin, GameRelease gameRelease, string dataFolderPath) =>
        _adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(Path.GetFileName(plugin.Path)), plugin.Path),
            gameRelease,
            _schemaReflector.GetSchemas(gameRelease),
            new PluginStrings(LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path), dataFolderPath));

    /// <summary>ADR-0015 invariant 4's reconcile request: validates <paramref name="plugin"/>, or
    /// every registered copy when null, and repairs what differs. <c>NeedsRebuild</c> names a copy
    /// this call re-derived whole.</summary>
    public IReadOnlyList<ValidationReport> ValidateIndex(PluginCopyKey? plugin)
    {
        // Outside _lock, as every mutation door here is: validate refreshes rows through the index's
        // own verbs, and the gate is reentrant so the rebuild below can take it again.
        using var _ = WriteGate.Enter();

        var (_, index) = RequireScopeCore();
        // One advance for everything this validate re-derives, however many copies it names.
        using var projection = index.BeginProjection();
        var keys = plugin is { } one ? (IReadOnlyList<PluginCopyKey>)[one] : index.RegisteredPlugins();

        var order = _holder.Current;
        var reports = new List<ValidationReport>(keys.Count);
        foreach (var key in keys)
        {
            var report = index.Validate(key, order.ModFolderOf(key));
            foreach (var failure in report.Failures)
                _logger.LogWarning("Reconciling {Plugin}: {Failure}", key.Name, failure);

            // A record set that moved is a whole-plugin re-derivation, which is the indexer's to
            // run: it holds the mod and knows which truth this copy reads (ADR-0007 invariant 3).
            if (report.NeedsRebuild) ReindexHeldCopy(key);
            reports.Add(report);
        }

        ReapplyFilter();
        return reports;
    }

    /// <summary>ADR-0015 invariant 2's narrow signal: re-projects these keys from the source tree
    /// under the write gate. An untracked or unheld copy is a no-op.</summary>
    public void RefreshKeys(PluginCopyKey key, IReadOnlyList<string> formKeys)
    {
        // Taken before anything reaches _lock or the index: this runs on the Source watcher's timer,
        // with nothing else ordering it against an in-flight edit.
        using var _ = WriteGate.Enter();

        var (_, index) = RequireScopeCore();
        // Every key named here is one logical write, so it lands as one advance.
        using var projection = index.BeginProjection();

        // Re-derived every call, never remembered from when the watch started: the repository can be
        // deleted or replaced between the event and this line, and then there is no truth to read.
        if (SourceRepository.TrackedModFolderOf(_holder.Current, key) is not { } modFolder) return;

        index.RefreshByKeys(key, modFolder, formKeys);
        ReapplyFilter();
    }

    // ADR-0013 invariant 3: the sweep is handed who competes, read from the kernel's load order —
    // the rule is Registration.Participates and runs there. Read whole, not per plugin.
    private IReadOnlyList<RegisteredCopy> Participating() => _holder.Current.Participating;

    // Which truth it reads is the plugin's: an untracked copy from its binary, a tracked copy from
    // its source tree (ADR-0007 invariant 3), because reading a tracked copy's binary would discard
    // uncommitted edits.
    private void ReindexHeldCopy(PluginCopyKey key)
    {
        // Taken before anything reaches _lock: this runs on the watcher's timer. IndexWriteGate is a
        // Lock, thread-affine, so nothing under this scope may await — the thread that exits must be
        // the one that entered.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease, dataFolderPath) = RequireHeldCopy(key);
        // ADR-0015 invariant 3: a whole copy re-derived is one projection, so it is one advance
        // whichever branch below runs.
        using var projection = index.BeginProjection();

        // A tracked copy's truth is its source tree, so it is re-derived from there and its binary
        // is never opened.

        // Asked here as a bare "is this tracked" question; the door below resolves the tree it reads
        // for itself, so neither trusts the other about a folder either could have lost in between.
        if (SourceIngest.HoldsTree(metadata.Origin, metadata.Path, metadata.Name))
            IngestFromSourceTree(key);
        else
            ReindexOne(metadata, index, gameRelease, dataFolderPath);
    }

    // The same SourceIngest.Ingest the reconcile's tracked branch runs, so a re-ingest and a first
    // ingest produce the same rows by construction. A failed read is recorded and rethrown, never
    // degraded to the binary.
    private void IngestFromSourceTree(PluginCopyKey key)
    {
        // Outside _lock, always. It takes the gate for itself rather than trusting its caller; the
        // reentrant gate makes that free.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease, _) = RequireHeldCopy(key);
        using var projection = index.BeginProjection();
        if (!SourceIngest.HoldsTree(metadata.Origin, metadata.Path, metadata.Name))
        {
            throw new InvalidOperationException(
                $"Plugin '{key.Name}' from '{key.Origin}' has no source tree to re-ingest; it is not tracked.");
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Re-ingesting {Plugin} from its source tree", metadata.Name);
        }

        // Under _lock, unlike the reconcile's own ingest: this fires against a live index that every
        // other mutation door is serialized against by this same lock.
        lock (_lock)
        {
            try
            {
                var modFolder = LoadOrderSnapshot.ModFolderOf(metadata.Origin, metadata.Path)
                    ?? throw new InvalidOperationException(
                        $"'{metadata.Name}' from '{metadata.Origin}' holds a source tree, so it cannot be the game's own Data directory.");
                SourceIngest.Ingest(
                    index, modFolder,
                    metadata.Registration, metadata.Key, metadata.Path, gameRelease, _schemaReflector, _logger);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not re-ingest {Plugin} from its source tree", metadata.Name);
                _heldPlugins?.SetFailure(key,
                    $"Could not re-read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Still " +
                    "showing what was last read from it — the compiled binary is not used for a tracked plugin.");
                throw;
            }

            index.UpdateWinners(Participating());
            ReapplyFilter();
        }
        AnnouncePluginChanged(index, key);
    }

    private (PluginMetadata Metadata, IRecordIndex Index, GameRelease GameRelease, string DataFolderPath) RequireHeldCopy(PluginCopyKey key)
    {
        lock (_lock)
        {
            var scope = RequireScopeCore();
            var metadata = scope.Held.Find(key)
                ?? throw new KeyNotFoundException($"Plugin '{key.Name}' from '{key.Origin}' is not held.");
            return (metadata, scope.Index, _gameRelease, scope.Held.DataFolderPath);
        }
    }

    private void ReindexOne(PluginMetadata metadata, IRecordIndex index, GameRelease gameRelease, string dataFolderPath)
    {
        using var documents = OpenDocuments(metadata, gameRelease, dataFolderPath);

        lock (_lock)
        {
            index.Index(documents, metadata.Registration, metadata.Key, metadata.Path, DerivedFrom.Binary);
            index.UpdateWinners(Participating());
            ReapplyFilter();
        }
        AnnouncePluginChanged(index, metadata.Key);
    }

    // The file is gone, so its rows go with it. A no-op while the held copy still exists or with no
    // load order: the watcher that calls this races teardowns and superseding load orders.
    private void UnindexGoneCopy(PluginCopyKey key)
    {
        // The watcher's timer's other index write — a vanished binary — gated like its sibling
        // above. Outside _lock, never inside it.
        using var _ = WriteGate.Enter();

        IRecordIndex index;
        lock (_lock)
        {
            if (_index is not { } held) return;
            if (_heldPlugins?.Find(key) is { } copy && File.Exists(copy.Path)) return;
            index = held;

            // Removing a copy is one projection: its rows and the winners they moved.
            using var projection = index.BeginProjection();

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) is gone from disk; removing it from the index", key.Name, key.Origin);
            }
            index.Unindex(key);
            // A removal moves winners for every FormKey it held, exactly as a re-index does.
            index.UpdateWinners(Participating());
            ReapplyFilter();
        }
        AnnouncePluginChanged(index, key);
    }

    /// <summary>See <see cref="IRefreshIndex.RefreshBinary"/>. Nothing here awaits: the comparison
    /// and every re-derivation are synchronous under the write gate.</summary>
    public Task<bool> RefreshBinary(PluginCopyKey key, string path) => Task.FromResult(RefreshBinaryNow(key, path));

    private bool RefreshBinaryNow(PluginCopyKey key, string path)
    {
        if (!File.Exists(path))
        {
            var wasIndexed = IndexedContentHash(key) is not null;
            UnindexGoneCopy(key);
            return wasIndexed;
        }

        if (IndexedContentHash(key) is { } indexedHash)
        {
            if (ContentHashOnDisk(path) == indexedHash) return false;
            ReindexHeldCopy(key);
            return true;
        }

        return IndexNotYetHeld(key);
    }

    // A copy the load order names but no reconcile has opened (ADR-0003): opened and indexed here,
    // the single-copy counterpart of ReconcileProgressively's own arriving loop.
    private bool IndexNotYetHeld(PluginCopyKey key)
    {
        using var _ = WriteGate.Enter();

        HeldPlugins held;
        IRecordIndex index;
        lock (_lock)
        {
            if (_heldPlugins is not { } h || _index is not { } i) return false;
            (held, index) = (h, i);
        }

        if (_holder.Current.Copy(key) is not { } copy) return false;

        if (held.Open(copy) is not { } metadata)
        {
            lock (_lock) _failedHashes[key] = PluginBinaryHash.OfFile(copy.Path);
            PublishStatus();
            return false;
        }
        lock (_lock) _failedHashes.Remove(key);

        // The sweep is part of the copy's own projection, so the announcement names the sequence
        // the winners landed on.
        using (index.BeginProjection())
        {
            if (!RegisterOrIndex(held, index, metadata, CancellationToken.None)) return false;

            lock (_lock)
            {
                index.UpdateWinners(Participating());
                ReapplyFilter();
            }
            AnnouncePluginChanged(index, metadata.Key);
        }
        return true;
    }

    /// <summary>See <see cref="IQueryIndex.FilterSql"/>.</summary>
    public string? FilterSql { get { lock (_lock) return _filterSql; } }

    /// <summary>Throws <see cref="ArgumentException"/> if the SQL does not return a form_key
    /// column.</summary>
    public void SetFilter(string sql) => ApplyFilter(sql);
    public void ClearFilter() => ApplyFilter(null);

    private void ApplyFilter(string? sql)
    {
        // Materializing _filter is an index write, and the filter box is live while an edit runs, so
        // racing an in-flight edit is the ordinary case. Gated at the public doors' one shared
        // implementation.

        // ReapplyFilter is deliberately not gated: every call site is already inside a gated write,
        // or inside the reconcile, which holds the exclusive lock instead. Gating there would newly
        // make a reconcile wait on an edit.
        using var _ = WriteGate.Enter();

        lock (_lock)
        {
            var (_, index) = RequireScopeCore();
            index.SetFilter(sql);
            _filterSql = sql;
        }
    }

    // `_lock` is reentrant, so every projection path calls this from inside the lock scope it
    // already holds around its own Index/UpdateWinners calls rather than dropping and retaking it.
    private void ReapplyFilter()
    {
        lock (_lock)
        {
            if (_filterSql is not { } sql || _index is null) return;
            try
            {
                _index.SetFilter(sql);
            }
            catch (System.Data.Common.DbException ex)
            {
                // The write this followed is already durable by the time any call site reaches here,
                // so propagating would 500 a gesture that succeeded, over a table that is only a
                // filtered view. The warning is what keeps the degradation observable.
                _logger.LogWarning(ex,
                    "Could not re-materialize the active filter ({Error}); filtered listings may be " +
                    "stale until the filter is reapplied", ex.Message);
            }
        }
    }

    /// <summary>ADR-0009 invariant 5's rebuild: closes the scope, drops the instance's index file and
    /// reopens it empty, flooring its sequence at what this process handed out. The next reconcile
    /// fills it.</summary>
    public void RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        var previousSequence = Sequence;
        Close();
        using var rebuilt = _indexFactory.Rebuild(gameRelease, instanceRoot, previousSequence);
    }

    // Drops the scope: the copies it has open and the store's connection. Cancels an in-flight
    // reconcile and waits for it to stop first. The kernel's load order is its own and is untouched.
    private void Close()
    {
        // Cancels an in-flight reconcile and waits for it to stop *before* disposing anything —
        // the teardown half of the cancellation. Disposing while the loop still holds the
        // index is a native crash, not a catchable one.
        EnterExclusive();
        try { lock (_lock) DisposeCurrent(); }
        finally { ExitExclusive(); }

        PublishStatus();
    }

    public void Dispose()
    {
        // Guarded because Dispose owns the scope and the reconcile's cancellation: double disposal
        // is a supported call pattern here.
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
        }

        EnterExclusive();
        try
        {
            lock (_lock)
            {
                DisposeCurrent();
                // EndReconcile already clears this on every reconcile's own exit path; this is the
                // exclusive-holder's own backstop, not the common case.
                _reconcileCancellation?.Dispose();
                _reconcileCancellation = null;
            }
        }
        finally { ExitExclusive(); }
    }

    private void DisposeCurrent()
    {
        _heldPlugins = null;
        _index?.Dispose();
        _index = null;
        _filterSql = null;
        _indexed.Clear();
        _failedHashes.Clear();
        _conflictsComputed = false;
        _plannedCount = 0;
        _heldElsewhereMessage = null;
        _failureMessage = null;
    }
}
