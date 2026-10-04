using System.Diagnostics;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index;

/// <summary>ADR-0014: the Index's other half (target-architecture.d2
/// medit_readmodel.index.indexer). Ingest, the registration sweep and the validation of every
/// plugin.</summary>
public sealed class Indexer : IQueryIndex, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger _logger;
    private readonly DuckDbRecordIndexFactory _indexFactory;
    private readonly IPluginAdapter _adapter;
    // Null in every test that does not care, matching DuckDbRecordIndex's own posture.
    private readonly INotificationPublisher? _notifications;
    private readonly SchemaReflector _schemaReflector;
    private readonly TimeProvider _timeProvider;
    // Where a rebuild's refill runs; a test holds it back to order it against a reconcile.
    private readonly TaskScheduler _refillScheduler;
    // ADR-0013. The Indexer keeps no view of its own.
    private readonly LoadOrderHolder _holder;
    private HeldPlugins? _heldPlugins;
    private IRecordIndex? _index;
    // Survives a rebuild of its own scope, since it clears only on purpose (plugins.md, Order and
    // view state, story 5), and is dropped when another scope opens.
    private ScopedFilter? _filter;
    // The reconcile's own progress. Guarded by _lock like _heldPlugins/_index — written by
    // the reconciling thread as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<IndexedPlugin> _indexed = [];
    private bool _conflictsComputed;
    private bool _validating;
    private int _plannedCount;
    private int _activeCount;
    // Set only by the reconcile door's own catch, cleared at the top of every attempt: a repeated
    // refusal re-sets it a moment later, a successful one leaves it clear.
    private string? _heldElsewhereMessage;
    // The same lifetime as _heldElsewhereMessage, for the reconcile's other known-unknown outcome.
    private string? _failureMessage;
    // The version the reconcile door last finished answering for — never a superseded attempt's,
    // since that one returns before reaching its own update.
    private long _version;

    /// <summary>The composition root's door: the Index opens its own store (ADR-0014).</summary>
    public Indexer(
        LoadOrderHolder holder,
        IPluginAdapter adapter,
        SchemaReflector schemaReflector,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null,
        TaskScheduler? refillScheduler = null,
        IndexWriteGate? writeGate = null)
    {
        _holder = holder;
        WriteGate = writeGate ?? new IndexWriteGate();
        _adapter = adapter;
        _schemaReflector = schemaReflector;
        _notifications = notifications;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _refillScheduler = refillScheduler ?? TaskScheduler.Default;
        _logger = loggerFactory?.CreateLogger<Indexer>() ?? NullLogger<Indexer>.Instance;
        _indexFactory = new DuckDbRecordIndexFactory(
            schemaReflector, new TableDdlBuilder(schemaReflector), notifications,
            loggerFactory?.CreateLogger<DuckDbRecordIndexFactory>(), timeProvider);
    }

    // A plugin that failed to read stays in its error state (ADR-0013) until what it
    // reads from changes, which the state recorded beside it detects.
    private readonly Dictionary<PluginAddress, FailedRead?> _failedReads = new(PluginAddress.Comparer);

    // What a failed read read from: the binary's hash, and for a plugin with a tree, each document's
    // content stamp then, or the doubly claimed FormKey the tree named instead (ADR-0003).
    private sealed record FailedRead(string? Binary, RecordStamps? Stamps, string? Ambiguity = null);

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

    /// <summary>One per Indexer, never replaced — a reconcile swaps the store underneath it, which
    /// is when the ordering matters most. By construction the outer of the two locks: taking
    /// <c>_lock</c> first and then waiting here would deadlock.</summary>
    public IndexWriteGate WriteGate { get; }

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: before the first reconcile
    /// the Index has opened no store to read.</summary>
    public IRecordReads RequireReads() => RequireScopeCore().Index.Reads;

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
    /// it describes; failures come straight off the held plugins' own list rather than a second
    /// place that could disagree (ADR-0013).</summary>
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
                    var state = _conflictsComputed && !_validating ? LoadOrderState.Ready : LoadOrderState.Reconciling;
                    held = new LoadOrderStatus(state, _plannedCount, _activeCount, [.. _indexed], _conflictsComputed, _heldPlugins.Failures, Version: _version);
                }

                if (_heldElsewhereMessage is { } heldElsewhere)
                    return held with { State = LoadOrderState.HeldElsewhere, Message = heldElsewhere };
                if (_failureMessage is { } failure)
                    return held with { State = LoadOrderState.Failed, Message = failure };
                return held;
            }
        }
    }

    // ADR-0015: every site that changes what Status reports calls this after. _lock is
    // reentrant (see ReapplyFilter), so this is safe to call from inside a lock a caller already
    // holds.
    private void PublishStatus() => _notifications?.Publish(new LoadOrderStatusNotification(Status));

    public long Sequence { get { lock (_lock) return _index?.Sequence ?? 0; } }

    // ADR-0015: a whole plugin re-derived or removed has too many rows to name, so the
    // announcement names the plugin and the sequence the store reached once the projection landed.
    private void AnnouncePluginChanged(IRecordIndex index, PluginAddress key) =>
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

    // ADR-0013's one verb, then every plugin validated (ADR-0003). The arrival is read once the
    // exclusive right is held, so a refill reconciles the load order held then. Null reconciles
    // nothing.
    private void Reconcile(Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival)
    {
        long version = 0;
        bool changed;
        try
        {
            if (ReconcileOrRefuse(arrival, ref version) is not { } reconciled) return;
            changed = reconciled;
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
            changed = true;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // ReconcileOrRefuse already logged this at error; there is nothing further up to raise
            // it to, so it becomes status data instead of only a log line.
            lock (_lock) _failureMessage = ex.Message;
            changed = true;
        }
        // Max, not assign: the exclusive lock is released before this runs, so a newer version's
        // own stamp can land first, and this one must never answer for it downward.
        lock (_lock)
        {
            changed |= version > _version;
            _version = Math.Max(_version, version);
            _validating = false;
            if (changed) PublishStatus();
        }
    }

    // A superseded reconcile throws OperationCanceledException, leaving its work for its
    // successor; a second window's hold throws IndexHeldElsewhereException. Null when the arrival
    // resolved to none, and false when the reconcile changed nothing Status reports.
    private bool? ReconcileOrRefuse(Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival, ref long version)
    {
        EnterExclusive();
        try
        {
            if (arrival() is not { } resolved) return null;
            var (snapshot, arrived) = resolved;
            version = arrived;
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Reconciling load order. GameDir={GameDir} Instance={Instance} Plugins={Count} Game={Game}",
                    snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.Plugins.Count, snapshot.GameRelease);
            }

            // A fresh attempt starting: whatever the previous attempt's own refusal set is stale the
            // moment this one is asked for, whichever way this one goes.
            bool refusalCleared;
            lock (_lock)
            {
                refusalCleared = _heldElsewhereMessage is not null || _failureMessage is not null;
                _heldElsewhereMessage = null;
                _failureMessage = null;
            }
            var token = BeginReconcile();
            var (held, index) = EnsureScope(snapshot);
            var reconciled = ReconcileProgressively(held, index, snapshot, token) || refusalCleared;
            return ValidateHeld(token) || reconciled;
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

    // ADR-0010.
    // Published before any plugin is opened, which is what makes the reconcile progressive.
    private (HeldPlugins Held, IRecordIndex Index) EnsureScope(LoadOrderSnapshot snapshot)
    {
        lock (_lock)
        {
            if (_heldPlugins is { } current && _index is { } index && SameScope(ScopeOf(current), snapshot))
                return (current, index);
            DisposeCurrent();
            if (_filter is { } filter && !SameScope(filter.Scope, snapshot)) _filter = null;
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
        fresh.ReadOpenedPluginsFrom(() => held.OpenedPlugins);

        lock (_lock)
        {
            _indexed.Clear();
            _failedReads.Clear();
            _conflictsComputed = false;
            _plannedCount = 0;
            _activeCount = 0;
            _heldPlugins = held;
            _index = fresh;
            _gameRelease = snapshot.GameRelease;
            ReapplyFilter();
        }
        PublishStatus();
        return (held, fresh);
    }

    private readonly record struct IndexScope(GameRelease GameRelease, string DataFolderPath, string? InstanceRoot);

    private sealed record ScopedFilter(string Sql, string Source, IndexScope Scope);

    private static IndexScope ScopeOf(HeldPlugins held) => new(held.GameRelease, held.DataFolderPath, held.InstanceRoot);

    private static bool SameScope(IndexScope scope, LoadOrderSnapshot snapshot) =>
        scope.GameRelease == snapshot.GameRelease
        && SamePath(scope.DataFolderPath, snapshot.DataFolderPath)
        && (scope.InstanceRoot, snapshot.InstanceRoot) switch
        {
            (null, null) => true,
            ({ } a, { } b) => SamePath(a, b),
            _ => false,
        };

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

    // The diff is computed first and without side effects — one stamp read and a folder probe per
    // plugin — so a snapshot that moves nothing writes nothing and publishes no status.

    // Registrations the snapshot has stopped naming are dropped before anything new is opened, so a
    // freshly opened index file's last-run rows stop answering as early as possible. False when the
    // snapshot moved nothing.
    private bool ReconcileProgressively(
        HeldPlugins held, IRecordIndex index, LoadOrderSnapshot snapshot, CancellationToken token)
    {
        var resolved = snapshot.Plugins;
        var wanted = resolved.ToDictionary(r => r.Key, PluginAddress.Comparer);
        var open = held.Plugins.ToDictionary(p => p.Key, PluginAddress.Comparer);

        IReadOnlyList<PluginAddress> failed;
        lock (_lock) failed = [.. _failedReads.Keys];
        // Registered, held, or held only as a failure row — a plugin the snapshot has stopped naming
        // leaves by every one of those doors, so a stale error row cannot outlive its plugin.
        var leaving = index.RegisteredPlugins()
            .Concat(held.Plugins.Select(p => p.Key))
            .Concat(failed)
            .Where(k => !wanted.ContainsKey(k))
            .Distinct(PluginAddress.Comparer)
            .ToList();
        var moved = resolved
            .Select(r => r.Key)
            .Where(key => open.TryGetValue(key, out var h) && h.Registration != snapshot.RegistrationOf(key))
            .ToList();
        // A plugin in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !open.ContainsKey(r.Key) && !StillFailing(index, r.Key, r.Path)).ToList();
        // ADR-0007: which truth a plugin reads is its folder's answer, and the stamp
        // records the one its rows came from. Tracking and untracking move the first alone, and no
        // load-order difference above names them.
        var stampedFromSource = index.Reads.GetTrackedPlugins();
        var reDerived = resolved.Where(r => open.ContainsKey(r.Key) && TruthMoved(index, r, stampedFromSource)).ToList();

        bool conflictsComputed;
        lock (_lock) conflictsComputed = _conflictsComputed;
        if (leaving.Count == 0 && moved.Count == 0 && arriving.Count == 0 && reDerived.Count == 0 && conflictsComputed)
        {
            _logger.LogDebug("Load order snapshot is identical to what is held; nothing to reconcile");
            return false;
        }

        lock (_lock)
        {
            _conflictsComputed = false;
            _validating = true;
            _plannedCount = resolved.Count;
            _activeCount = snapshot.Active.Count;
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
                _indexed.RemoveAll(i => PluginAddress.Comparer.Equals(new PluginAddress(i.Name, i.Origin), key));
                _failedReads.Remove(key);
            }
        }
        if (leaving.Count > 0) PublishStatus();

        foreach (var key in moved)
        {
            // ADR-0012.
            var metadata = held.Update(open[key], snapshot.RegistrationOf(key));
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

            if (held.Open(plugin, snapshot.RegistrationOf(plugin.Key)) is not { } metadata)
            {
                RecordFailedRead(index, plugin.Key, plugin.Path);
                continue;
            }
            lock (_lock) _failedReads.Remove(plugin.Key);

            RegisterOrIndex(held, index, metadata, token);
            // A plugin is browsable the moment it lands, so the rows the filter matches in it must
            // answer then too, not only after the whole set (plugins.md, Order and view state).
            ReapplyFilter();
            firstUsableMs ??= timer.ElapsedMilliseconds;
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0013).
        _logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        index.UpdateWinners(snapshot.Active);
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
        return true;
    }

    // A plugin that failed the last re-derivation is not read again until what it reads from changes.
    private bool TruthMoved(IRecordIndex index, RegisteredPlugin plugin, IReadOnlySet<PluginAddress> stampedFromSource)
    {
        var holdsTree = SourceIngest.HoldsTree(plugin.Origin, plugin.Path, plugin.Name);
        return holdsTree != stampedFromSource.Contains(plugin.Key) && !StillFailing(index, plugin.Key, plugin.Path);
    }

    // A plugin whose folder was tracked or untracked since it was indexed. Nothing here has compared
    // the two truths, so the plugin is re-derived whole from the one its folder now offers.
    private void ReDeriveMovedTruths(
        HeldPlugins held, IRecordIndex index, IReadOnlyList<RegisteredPlugin> plugins, CancellationToken token)
    {
        foreach (var plugin in plugins)
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
            try
            {
                IndexOnePlugin(held, index, metadata, holdsTree, token);
                lock (_lock) _failedReads.Remove(plugin.Key);
            }
            catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
            {
                // plugins.md, A row, Plugin: one plugin that cannot be read is that row's "Failed to
                // read", never the whole index's failure.
                _logger.LogWarning(ex, "Failed to re-derive {Plugin} ({Origin})", plugin.Name, plugin.Origin);
                FailRead(held, index, plugin.Key, plugin.Path, PluginLoadFailure.ReasonFor(ex));
            }
        }
    }

    // Registers first: the index's reads are scoped by registration, so validate would otherwise
    // compare an empty row set against a full tree. False falls through to a full index.
    private bool WarmRegister(IRecordIndex index, PluginMetadata plugin, bool holdsTree)
    {
        index.Register(plugin.Key, plugin.Registration);

        // An untracked plugin's binary was already hashed against its stored claim when the index file
        // opened (Store.ValidateAgainstDisk), so a second hash of every binary here would pay
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

    // While what it reads from is unchanged the error state stands, and the parse is not paid again.
    private bool StillFailing(IRecordIndex index, PluginAddress key, string path)
    {
        FailedRead? failedAt;
        lock (_lock)
        {
            if (!_failedReads.TryGetValue(key, out failedAt)) return false;
        }
        return failedAt is not null && ReadStateOf(index, key, path) is { } now && failedAt == now;
    }

    // A failure that says what the plugin already said publishes nothing.
    private void FailRead(HeldPlugins? held, IRecordIndex index, PluginAddress key, string path, string reason) =>
        Fail(held, key, reason, ReadStateOf(index, key, path));

    // A file another process held is read again at the next snapshot, whatever it reads from.
    private void FailReadUntilTheNextSnapshot(HeldPlugins held, PluginAddress key, string reason) =>
        Fail(held, key, reason, readFrom: null);

    private void Fail(HeldPlugins? held, PluginAddress key, string reason, FailedRead? readFrom)
    {
        var told = held?.SetFailure(key, reason) == true;
        lock (_lock) _failedReads[key] = readFrom;
        if (told) PublishStatus();
    }

    private void RecordFailedRead(IRecordIndex index, PluginAddress key, string path)
    {
        var state = ReadStateOf(index, key, path);
        lock (_lock) _failedReads[key] = state;
    }

    // Null, which vouches for nothing, when what the plugin reads from cannot be read: an untracked
    // binary, or a tree with an unreadable document.
    private FailedRead? ReadStateOf(IRecordIndex index, PluginAddress key, string path)
    {
        var binary = index.FileContentHash(path);
        if (LoadOrderSnapshot.ModFolderOf(key.Origin, path) is not { } modFolder
            || !SourceRepository.HoldsTreeFor(modFolder, key.Name))
        {
            return binary is null ? null : new FailedRead(binary, null);
        }

        try
        {
            var stamps = SourceRepository.Over(modFolder, _gameRelease).StampsOf(key);
            return stamps.Unreadable.Count == 0 ? new FailedRead(binary, stamps) : null;
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return new FailedRead(binary, null, ex.Message);
        }
    }

    // ADR-0010: a plugin the store has seen, still matching the disk, is registered, not
    // indexed; ADR-0015 validates a tracked plugin by content on that same warm path.
    private void RegisterOrIndex(HeldPlugins held, IRecordIndex index, PluginMetadata plugin, CancellationToken token)
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
            return;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
        }
        var indexTimer = Stopwatch.StartNew();
        try
        {
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
            FailRead(held, index, key, plugin.Path, PluginLoadFailure.ReasonFor(ex));
            return;
        }

        lock (_lock)
        {
            // Recorded only once Index() has returned: Status promises a plugin here is wholly
            // queryable, so listing it any earlier would be the partial-visibility lie in a
            // different form.
            _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
        }
        PublishStatus();
    }

    // ADR-0007; HeldPlugins still reads a tracked plugin's metadata off its binary.

    // A failed source read degrades to the binary, but records a real PluginLoadFailure: a silent
    // fallback would leave the user reading pre-Track binary content believing it was their source.
    private void IndexOnePlugin(
        HeldPlugins held, IRecordIndex index, PluginMetadata plugin,
        bool holdsTree, CancellationToken token)
    {
        // One advance for the whole plugin, whichever door it came through (ADR-0015).
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
            var modFolder = ModFolderHoldingTree(plugin);
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
            RecordFailedRead(index, plugin.Key, plugin.Path);
        }

        IndexFromBinary(held, index, plugin);
    }

    private static string ModFolderHoldingTree(PluginMetadata plugin) =>
        LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path)
            ?? throw new InvalidOperationException(
                $"'{plugin.Name}' from '{plugin.Origin}' holds a source tree, so its origin is neither the game's own Data directory nor Overwrite.");

    // ADR-0005: the binary reaches the index as documents, through the adapter's own door,
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
            new PluginStrings(LoadOrderSnapshot.FileFolderOf(plugin.Path), dataFolderPath));

    // ADR-0015.
    private void ValidateIndex(CancellationToken token)
    {
        // Outside _lock, as every mutation door here is: validate refreshes rows through the index's
        // own verbs, and the gate is reentrant so the rebuild below can take it again.
        using var _ = WriteGate.Enter();

        var (held, index) = RequireScopeCore();
        // One advance for everything this validate re-derives.
        using var projection = index.BeginProjection();
        // A plugin not held failed to open, and the reconcile opens it again once its bytes change.
        foreach (var metadata in held.Plugins)
        {
            token.ThrowIfCancellationRequested();
            ValidateOne(held, index, metadata);
        }

        ReapplyFilter();
    }

    // plugins.md, A row, Plugin, "Failed to read": a plugin that cannot be read is flagged, and the
    // rest are still validated. A failed one is read whole again once what it reads from changed.
    private void ValidateOne(HeldPlugins held, IRecordIndex index, PluginMetadata plugin)
    {
        var key = plugin.Key;
        var modFolder = LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path);
        var holdsTree = modFolder is not null && SourceRepository.HoldsTreeFor(modFolder, plugin.Name);
        try
        {
            if (!holdsTree && !File.Exists(plugin.Path))
            {
                if (index.IndexedContentHash(key) is not null) UnindexGonePlugin(key);
                return;
            }

            // Rows a failed read left say nothing of what the plugin now reads from.
            if (held.IsHeldWithAFailure(key))
            {
                if (!StillFailing(index, key, plugin.Path)) ReindexHeldPlugin(key);
                return;
            }

            var report = index.Validate(key, modFolder);
            if (report.Failures.Count > 0)
            {
                foreach (var failure in report.Failures)
                    _logger.LogWarning("Reconciling {Plugin}: {Failure}", key.Name, failure);
                FailRead(held, index, key, plugin.Path, ValidationFailure(holdsTree, string.Join("; ", report.Failures)));
                return;
            }

            // Gained records are refreshed by key so the rows that moved are named (ADR-0015).
            if (report.NeedsRebuild && report.ChangedKeys.Count > 0 && modFolder is { } folder)
            {
                RefreshByKeysOrReadWhole(index, key, folder, report.ChangedKeys);
            }
            // An untracked plugin's rows went with its file, and the file is back.
            else if (report.NeedsRebuild || (!holdsTree && index.IndexedContentHash(key) is null))
            {
                ReindexHeldPlugin(key);
            }
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            _logger.LogWarning(ex, "Could not validate {Plugin} ({Origin})", key.Name, key.Origin);
            // A re-read that failed has named its own failure.
            if (!held.IsHeldWithAFailure(key))
            {
                var reason = ValidationFailure(holdsTree, PluginLoadFailure.ReasonFor(ex));
                if (ex is IOException or UnauthorizedAccessException) FailReadUntilTheNextSnapshot(held, key, reason);
                else FailRead(held, index, key, plugin.Path, reason);
            }
        }
    }

    // editor.md, States, story 6: the rows stay the last good read, and say why.
    private static string ValidationFailure(bool holdsTree, string reason) =>
        $"Could not validate this plugin's {(holdsTree ? "source tree" : "binary")} ({reason}). Still showing " +
        "what was last read from it.";

    // ADR-0003: the status answering the version is published once the plugins are validated, and a
    // reconcile that changed the status reads Reconciling until then. True when validation failed
    // outright and became status data.
    private bool ValidateHeld(CancellationToken token)
    {
        lock (_lock)
        {
            if (_disposed || _heldPlugins is null) return false;
        }
        try
        {
            ValidateIndex(token);
            return false;
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // Busy, not broken: validation is idempotent, and the next snapshot validates again.
            _logger.LogWarning(ex, "Could not validate the index while another write held it; it is re-checked at the next snapshot");
            return false;
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            // The failure becomes status data (plugins.md, States, story 6), and the next snapshot
            // tries again.
            _logger.LogError(ex, "Validating the index failed unexpectedly");
            lock (_lock) _failureMessage = ex.Message;
            return true;
        }
    }

    // A tree the keys cannot be read from is diagnosed on the plugin by the whole read, as a first
    // ingest would diagnose it.
    private void RefreshByKeysOrReadWhole(
        IRecordIndex index, PluginAddress key, string modFolder, IReadOnlyList<string> formKeys)
    {
        try
        {
            index.RefreshByKeys(key, modFolder, formKeys);
        }
        catch (Exception ex) when (ex is AmbiguousSourceUnitException or UnreadableSourceDocumentException)
        {
            ReindexHeldPlugin(key);
        }
    }

    // ADR-0013, read whole rather than per plugin.
    private IReadOnlyList<RegisteredPlugin> Active() => _holder.Current.Active;

    // ADR-0007.
    private void ReindexHeldPlugin(PluginAddress key)
    {
        // Taken before anything reaches _lock. IndexWriteGate is a Lock, thread-affine, so nothing
        // under this scope may await — the thread that exits must be the one that entered.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease, dataFolderPath) = RequireHeldPlugin(key);
        // ADR-0015: a whole plugin re-derived is one projection, so it is one advance
        // whichever branch below runs.
        using var projection = index.BeginProjection();

        // A tracked plugin's truth is its source tree, so it is re-derived from there and its binary
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
    private void IngestFromSourceTree(PluginAddress key)
    {
        // Outside _lock, always. It takes the gate for itself rather than trusting its caller; the
        // reentrant gate makes that free.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease, _) = RequireHeldPlugin(key);
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
                var modFolder = ModFolderHoldingTree(metadata);
                SourceIngest.Ingest(
                    index, modFolder,
                    metadata.Registration, metadata.Key, metadata.Path, gameRelease, _schemaReflector, _logger);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not re-ingest {Plugin} from its source tree", metadata.Name);
                FailRead(_heldPlugins, index, key, metadata.Path,
                    $"Could not re-read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Still " +
                    "showing what was last read from it — the compiled binary is not used for a tracked plugin.");
                throw;
            }

            index.UpdateWinners(Active());
            ReapplyFilter();
        }
        lock (_lock) _failedReads.Remove(key);
        if (_heldPlugins?.ClearFailure(key) == true) PublishStatus();
        AnnouncePluginChanged(index, key);
    }

    private (PluginMetadata Metadata, IRecordIndex Index, GameRelease GameRelease, string DataFolderPath) RequireHeldPlugin(PluginAddress key)
    {
        lock (_lock)
        {
            var scope = RequireScopeCore();
            var metadata = scope.Held.Find(key)
                ?? throw new KeyNotFoundException($"Plugin '{key.Name}' from '{key.Origin}' is not held.");
            return (metadata, scope.Index, _gameRelease, scope.Held.DataFolderPath);
        }
    }

    // A failed read is recorded with the bytes it failed on and rethrown, so those bytes are not
    // read again until they change.
    private void ReindexOne(PluginMetadata metadata, IRecordIndex index, GameRelease gameRelease, string dataFolderPath)
    {
        try
        {
            using var documents = OpenDocuments(metadata, gameRelease, dataFolderPath);
            lock (_lock)
            {
                index.Index(documents, metadata.Registration, metadata.Key, metadata.Path, DerivedFrom.Binary);
                index.UpdateWinners(Active());
                ReapplyFilter();
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            FailRead(_heldPlugins, index, metadata.Key, metadata.Path, PluginLoadFailure.ReasonFor(ex));
            throw;
        }
        lock (_lock) _failedReads.Remove(metadata.Key);
        if (_heldPlugins?.ClearFailure(metadata.Key) == true) PublishStatus();
        AnnouncePluginChanged(index, metadata.Key);
    }

    // The file is gone, so its rows go with it. A no-op while the held plugin still exists or with no
    // load order.
    private void UnindexGonePlugin(PluginAddress key)
    {
        // Gated like its sibling above. Outside _lock, never inside it.
        using var _ = WriteGate.Enter();

        IRecordIndex index;
        lock (_lock)
        {
            if (_index is not { } held) return;
            if (_heldPlugins?.Find(key) is { } plugin && File.Exists(plugin.Path)) return;
            index = held;

            // Removing a plugin is one projection: its rows and the winners they moved.
            using var projection = index.BeginProjection();

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) is gone from disk; removing it from the index", key.Name, key.Origin);
            }
            index.Unindex(key);
            // A removal moves winners for every FormKey it held, exactly as a re-index does.
            index.UpdateWinners(Active());
            ReapplyFilter();
        }
        AnnouncePluginChanged(index, key);
    }

    /// <summary>The filter in force and the source its SQL came from, read together so a
    /// concurrent set never pairs one filter's SQL with another's source.</summary>
    public (string Sql, string Source)? ActiveFilter
    {
        get { lock (_lock) return _filter is { } filter ? (filter.Sql, filter.Source) : null; }
    }

    /// <summary>Throws <see cref="ArgumentException"/> if the SQL does not return a form_key
    /// column.</summary>
    public void SetFilter(string sql, string source) => ApplyFilter((sql, source));
    public void ClearFilter() => ApplyFilter(null);

    private void ApplyFilter((string Sql, string Source)? filter)
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
            // A filter kept through a rebuild outlives the store it was materialized in, and one
            // that is reported must clear, store or no store.
            if (filter is null && _index is null)
            {
                _filter = null;
                return;
            }
            var (held, index) = RequireScopeCore();
            index.SetFilter(filter?.Sql);
            _filter = filter is { } set ? new ScopedFilter(set.Sql, set.Source, ScopeOf(held)) : null;
        }
    }

    // `_lock` is reentrant, so every projection path calls this from inside the lock scope it
    // already holds around its own Index/UpdateWinners calls rather than dropping and retaking it.
    private void ReapplyFilter()
    {
        lock (_lock)
        {
            if (_filter is not { } filter || _index is null) return;
            try
            {
                _index.SetFilter(filter.Sql);
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

    /// <summary>ADR-0010: drops the index file, floors its sequence at what this process
    /// handed out, and refills it off the caller's thread; a file another window holds is refused.</summary>
    public StoreRebuild RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        var previousSequence = Sequence;
        Close();
        try
        {
            // Released before the reconcile below opens the same file for its own scope.
            _indexFactory.Rebuild(gameRelease, instanceRoot, previousSequence).Dispose();
        }
        catch (IndexHeldElsewhereException ex)
        {
            _logger.LogWarning(ex, "Refused to rebuild: the index at {Path} is held by another window", ex.IndexPath);
            return new StoreRebuild(Task.CompletedTask, ex.Message);
        }

        return new StoreRebuild(Task.Factory.StartNew(
            ReconcileHeld, CancellationToken.None, TaskCreationOptions.LongRunning, _refillScheduler));
    }

    /// <summary>Reconciles every arrival of the load order, changed or not, on a thread of its own
    /// (ADR-0013): the snapshot held when it runs, so an overtaken arrival reconciles
    /// the newer.</summary>
    public void Subscribe() => _holder.Arrived += OnArrived;

    private void OnArrived(LoadOrderSnapshot snapshot, long version) =>
        Task.Factory.StartNew(ReconcileHeld, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    // Disposal is read with the exclusive right held, which Dispose takes after setting it, so no
    // reconcile opens a store after Dispose.
    private void ReconcileHeld() => Reconcile(() =>
    {
        lock (_lock) return _disposed ? null : _holder.Held;
    });

    // Drops the scope: the plugins it has open and the store's connection. Cancels an in-flight
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
        _holder.Arrived -= OnArrived;

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
        _indexed.Clear();
        _failedReads.Clear();
        _conflictsComputed = false;
        _validating = false;
        _plannedCount = 0;
        _activeCount = 0;
        _heldElsewhereMessage = null;
        _failureMessage = null;
    }
}
