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
public sealed class IndexProjector : IQueryIndex, IRefreshIndex, IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger _logger;
    private readonly IRecordIndexFactory _indexFactory;
    private readonly IPluginAdapter _adapter;
    // ADR-0014: null in every test that does not care, matching DuckDbRecordIndex's own posture.
    private readonly INotificationPublisher? _notifications;
    // A direct constructor parameter rather than routed through IRecordIndexFactory, which has no
    // other reason to carry it; DI already registers SchemaReflector as its own singleton.
    private readonly SchemaReflector _schemaReflector;
    // ADR-0013 invariant 4: the one load order, the kernel's. The projector reads it for who
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

    /// <summary>The composition root's door: the Index opens its own store, so nothing outside this
    /// project names the store, its factory or how a file is opened (ADR-0009).</summary>
    public IndexProjector(
        LoadOrderHolder holder,
        IPluginAdapter adapter,
        SchemaReflector schemaReflector,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null)
        : this(
            holder,
            adapter,
            new DuckDbRecordIndexFactory(
                schemaReflector, new TableDdlBuilder(schemaReflector), notifications,
                loggerFactory?.CreateLogger<DuckDbRecordIndexFactory>()),
            loggerFactory?.CreateLogger<IndexProjector>(), schemaReflector, notifications)
    {
    }

    /// <summary>The store's factory as a seam, for a test that faults or counts what the store
    /// does.</summary>
    internal IndexProjector(
        LoadOrderHolder holder,
        IPluginAdapter adapter,
        IRecordIndexFactory indexFactory,
        ILogger? logger = null,
        SchemaReflector? schemaReflector = null,
        INotificationPublisher? notifications = null)
    {
        _holder = holder;
        _indexFactory = indexFactory;
        _logger = logger ?? NullLogger.Instance;
        _adapter = adapter;
        _schemaReflector = schemaReflector ?? new SchemaReflector();
        _notifications = notifications;
    }

    // ADR-0013: a copy that failed to open stays a row in an error state until its bytes change.
    // Keyed by the plugin; the hash recorded alongside it is what changing detects.
    private readonly Dictionary<string, (PluginKey Key, string? Hash)> _failedHashes = new(StringComparer.OrdinalIgnoreCase);

    // Two mechanisms, because one is not enough: the token asks the reconcile loop to stop, the
    // gate waits until it has. Cancelling without draining would let a teardown dispose the DuckDB
    // connection mid-write, a native crash.

    // Deliberately not _lock: the reconciling thread takes _lock on every plugin, so a waiter
    // holding it could never be signalled.
    private readonly SemaphoreSlim _reconcileGate = new(1, 1);
    private CancellationTokenSource? _reconcileCancellation;
    private bool _disposed;

    // Takes the exclusive right to reconcile or tear down, waiting out any in-flight reconcile.
    // Always paired with ExitExclusive in a finally.
    private void EnterExclusive()
    {
        // Cancel and dispose both happen under _lock, so a token can never be cancelled after it has
        // been disposed.
        lock (_lock) _reconcileCancellation?.Cancel();
        _reconcileGate.Wait();
    }

    private void ExitExclusive() => _reconcileGate.Release();

    private GameRelease _gameRelease;

    public IRecordReads? Reads { get { lock (_lock) return _index?.At(RecordRef.Effective); } }
    /// <summary>The store the projections land in. Internal: ADR-0014 invariant 5 makes the Index
    /// one module, and the rows behind this are its own. Null until a reconcile opens one.</summary>
    internal IRecordIndex? Store { get { lock (_lock) return _index; } }

    /// <summary>Whether the store registers this copy — an endpoint's 404 question, answered without
    /// handing out the store.</summary>
    public bool Registers(PluginKey key)
    {
        lock (_lock) return _index?.RegisteredPlugins().Contains(key) == true;
    }

    /// <summary>ADR-0009: the hash the store's rows for this copy were built from, or null when it
    /// holds no validated rows for it — the watch registration's one question of the store.</summary>
    public string? IndexedContentHash(PluginKey key)
    {
        lock (_lock) return _index?.IndexedContentHash(key);
    }

    /// <summary>See <see cref="IRefreshIndex.ContentHashOnDisk"/>. No lock: it reads the file, not
    /// the store.</summary>
    public string? ContentHashOnDisk(string pluginPath) => PluginBinaryHash.OfFile(pluginPath);

    /// <summary>One per projector, never replaced — a reconcile swaps the store underneath it, which
    /// is when the ordering matters most. By construction the outer of the two locks: taking
    /// <c>_lock</c> first and then waiting here would deadlock.</summary>
    public IndexWriteGate WriteGate { get; } = new();

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
    /// that could disagree (ADR-0013).</summary>
    public LoadOrderStatus Status
    {
        get
        {
            lock (_lock)
            {
                if (_heldPlugins is null) return LoadOrderStatus.None;
                var state = _conflictsComputed ? LoadOrderState.Ready : LoadOrderState.Reconciling;
                return new LoadOrderStatus(state, _plannedCount, [.. _indexed], _conflictsComputed, _heldPlugins.Failures);
            }
        }
    }

    // ADR-0014: every site that changes what Status reports calls this after. _lock is reentrant
    // (see ReapplyFilter), so this is safe to call from inside a lock a caller already holds.
    private void PublishStatus() => _notifications?.Publish(new LoadOrderStatusNotification(Status));

    public long Sequence { get { lock (_lock) return _index?.Sequence ?? 0; } }

    /// <summary>ADR-0014: everything projected inside the scope advances the sequence once, when
    /// the outermost of any nested scopes closes. A no-op with no store held.</summary>
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

    // Polling, not the notification port: this answers one caller's own bound, not every
    // subscriber, and every write already serializes through IndexWriteGate, so a short poll
    // answers within one interval of landing.
    private static readonly TimeSpan SequencePollInterval = TimeSpan.FromMilliseconds(20);

    /// <summary>Polls <see cref="Sequence"/> until it reaches <paramref name="atLeast"/> or
    /// <paramref name="timeout"/> elapses. True the moment it lands; false, never a throw, on a
    /// timeout — the answer is "not yet", not a failure.</summary>
    public async Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            if (Sequence >= atLeast) return true;
            var remaining = timeout - stopwatch.Elapsed;
            if (remaining <= TimeSpan.Zero) return false;
            await Task.Delay(remaining < SequencePollInterval ? remaining : SequencePollInterval).ConfigureAwait(false);
        }
    }

    /// <summary>ADR-0013's one verb: the store's registrations are made equal to the snapshot's
    /// copies, copies it has never held are indexed, then one winner sweep. A superseded reconcile
    /// throws, leaving its work for its successor.</summary>
    public void Reconcile(LoadOrderSnapshot snapshot)
    {
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Reconciling load order. GameDir={GameDir} Instance={Instance} Plugins={Count} Game={Game}",
                snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.Copies.Count, snapshot.GameRelease);
        }

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
            // cancelled this one owns the rest. Nothing was built that its successor will not want.
            _logger.LogWarning(ex, "Load order reconcile was superseded before it completed");
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

    // ADR-0009: the index's home is the MO2 instance — one persistent file per instance, so a fresh
    // open finds whatever the last run left there, and `origin` (a mod folder name) is unique only
    // within one.

    // Published before any plugin is opened, which is what makes the reconcile progressive (ADR-0013).
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

    private static string KeyOf(PluginKey key) => $"{key.Origin}\0{key.Name}";

    // The diff is computed first and without side effects, so an identical snapshot returns before
    // touching the index or the status: a redundant PUT is free.

    // Registrations the snapshot has stopped naming are dropped before anything new is opened, so a
    // freshly opened index file's last-run rows stop answering as early as possible.
    private void ReconcileProgressively(
        HeldPlugins held, IRecordIndex index, LoadOrderSnapshot snapshot, CancellationToken token)
    {
        var resolved = snapshot.Copies;
        var wanted = resolved.ToDictionary(r => KeyOf(r.Key), StringComparer.OrdinalIgnoreCase);
        var open = held.Plugins.ToDictionary(p => KeyOf(p.Key), StringComparer.OrdinalIgnoreCase);

        IReadOnlyList<PluginKey> failed;
        lock (_lock) failed = [.. _failedHashes.Values.Select(v => v.Key)];
        // Registered, held, or held only as a failure row — a copy the snapshot has stopped naming
        // leaves by every one of those doors, so a stale error row cannot outlive its copy.
        var leaving = index.RegisteredPlugins()
            .Concat(held.Plugins.Select(p => p.Key))
            .Concat(failed)
            .Where(k => !wanted.ContainsKey(KeyOf(k)))
            .DistinctBy(KeyOf, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var moved = resolved
            .Where(r => open.TryGetValue(KeyOf(r.Key), out var h) && h.Registration != r.Registration)
            .ToList();
        // A copy in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !open.ContainsKey(KeyOf(r.Key)) && !StillFailing(r)).ToList();

        bool conflictsComputed;
        lock (_lock) conflictsComputed = _conflictsComputed;
        if (leaving.Count == 0 && moved.Count == 0 && arriving.Count == 0 && conflictsComputed)
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
                _indexed.RemoveAll(i => i.Name.Equals(key.Name, StringComparison.OrdinalIgnoreCase)
                    && i.Origin.Equals(key.Origin, StringComparison.OrdinalIgnoreCase));
                _failedHashes.Remove(KeyOf(key));
            }
        }
        if (leaving.Count > 0) PublishStatus();

        foreach (var plugin in moved)
        {
            // ADR-0013: a reorder, an enable, a change of which copy wins — all the same SQL-only
            // move: no re-read, no re-index, so it is safe to apply live and unprompted.
            var metadata = held.Update(open[KeyOf(plugin.Key)], plugin.Registration);
            index.Register(metadata.Key, metadata.Registration);
        }

        // Two numbers ADR-0013 makes distinct — time to the first queryable plugin (the tree
        // becomes usable) and time to the winner sweep completing. Measured here rather than
        // client-side, where the 500 ms status poll caps the resolution.
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
                lock (_lock) _failedHashes[KeyOf(plugin.Key)] = (plugin.Key, PluginBinaryHash.OfFile(plugin.Path));
                continue;
            }
            lock (_lock) _failedHashes.Remove(KeyOf(plugin.Key));

            RegisterOrIndex(held, index, metadata, token);
            firstUsableMs ??= timer.ElapsedMilliseconds;
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0013).
        _logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        index.UpdateWinners(snapshot.Participating);
        lock (_lock) _conflictsComputed = true;
        // Ready: the last status transition a subscriber sees for this reconcile.
        PublishStatus();
        ReapplyFilter();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Load order reconciled in {TotalMs} ms: {Arrived} arrived, {Moved} moved, {Left} left, {Held} held (first plugin usable after {FirstUsableMs} ms, winner sweep {WinnersMs} ms)",
                timer.ElapsedMilliseconds, arriving.Count, moved.Count, leaving.Count, held.Plugins.Count,
                firstUsableMs, winnersTimer.ElapsedMilliseconds);
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
        (PluginKey, string? Hash) failedAt;
        lock (_lock)
        {
            if (!_failedHashes.TryGetValue(KeyOf(plugin.Key), out failedAt)) return false;
        }
        return failedAt.Hash != null && PluginBinaryHash.OfFile(plugin.Path) == failedAt.Hash;
    }

    // ADR-0009: a copy the index has already seen is registered rather than indexed — a non-null
    // content hash means "held, and still matching the bytes on disk".

    // ADR-0015 invariant 4: a tracked copy takes the same warm path, its source tree validated by
    // content where the untracked branch checked the binary hash at open. Only a moved document set
    // is re-derived whole.

    // The tree is resolved here because the register/index decision needs the answer the ingest does.
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
        catch (Exception ex)
        {
            // A single plugin with malformed record data must not abort the whole reconcile. Index()
            // runs in its own DuckDB transaction, so the rollback on throw leaves no partial rows.
            _logger.LogWarning(ex, "Failed to index {Plugin}; its records will not be queryable", plugin.Name);
            held.SetFailure(key, PluginLoadFailure.ReasonFor(ex));
            PublishStatus();
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

    // Where a plugin's records come from (ADR-0007): a tracked plugin's source tree, the binary for
    // everything else. Both branches end in the same Index call, which is what keeps the read model
    // free of a dialect.

    // The binary is still read for a tracked plugin — HeldPlugins asks the adapter for its metadata.
    // What this establishes is only "never consult the binary for a tracked plugin's content".

    // A failed source read degrades to the binary, but records a real PluginLoadFailure: a silent
    // fallback would leave the user reading pre-Track binary content believing it was their source.
    private void IndexOnePlugin(
        HeldPlugins held, IRecordIndex index, PluginMetadata plugin,
        bool holdsTree, CancellationToken token)
    {
        // One advance for the whole copy, whichever door it came through (ADR-0014).
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
            SourceIngest.Ingest(
                index, LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path)!,
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
        catch (Exception ex)
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
        index.Index(documents, plugin.Registration, plugin.Key, plugin.Path);
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
    public IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin)
    {
        // Outside _lock, as every mutation door here is: validate refreshes rows through the index's
        // own verbs, and the gate is reentrant so the rebuild below can take it again.
        using var _ = WriteGate.Enter();

        var (_, index) = RequireScopeCore();
        // One advance for everything this validate re-derives, however many copies it names.
        using var projection = index.BeginProjection();
        var keys = plugin is { } one ? (IReadOnlyList<PluginKey>)[one] : index.RegisteredPlugins();

        var order = _holder.Current;
        var reports = new List<ValidationReport>(keys.Count);
        foreach (var key in keys)
        {
            var report = index.Validate(key, order.ModFolderOf(key));
            foreach (var failure in report.Failures)
                _logger.LogWarning("Reconciling {Plugin}: {Failure}", key.Name, failure);

            // A record set that moved is a whole-plugin re-derivation, which is the projector's to
            // run: it holds the mod and knows which truth this copy reads (ADR-0007).
            if (report.NeedsRebuild) ReindexPlugin(key).GetAwaiter().GetResult();
            reports.Add(report);
        }

        ReapplyFilter();
        return reports;
    }

    /// <summary>ADR-0015 invariant 2's narrow signal: re-projects these keys from the source tree
    /// under the write gate. An untracked or unheld copy is a no-op.</summary>
    public void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys)
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

    // ADR-0013: the sweep is handed who competes, read from the kernel's load order — the rule is
    // Registration.Participates and runs there. Read whole, not per plugin.
    private IReadOnlyList<RegisteredCopy> Participating() => _holder.Current.Participating;

    /// <summary>Which truth it reads is the plugin's: an untracked copy from its binary, a tracked
    /// copy from its source tree (ADR-0007), because reading a tracked copy's binary would discard
    /// uncommitted edits.</summary>
    public Task ReindexPlugin(PluginKey key)
    {
        // Taken before anything reaches _lock or the index: this runs on the watcher's timer, with
        // nothing else ordering it against an in-flight edit. Reentrant, so the branch below taking
        // it again costs a recursion count, not a deadlock.

        // The `using` releases when this method returns, not when the returned Task completes, which
        // is correct only because both branches below are synchronous. A real `await` under either
        // must make this method `async` too, or the write is silently ungated.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease) = RequireHeldCopy(key);
        // ADR-0014: a whole copy re-derived is one projection, so it is one advance whichever
        // branch below runs.
        using var projection = index.BeginProjection();

        // A tracked copy's truth is its source tree, so it is re-derived from there and its binary
        // is never opened.

        // Asked here as a bare "is this tracked" question; the door below resolves the tree it reads
        // for itself, so neither trusts the other about a folder either could have lost in between.
        if (SourceIngest.HoldsTree(metadata.Origin, metadata.Path, metadata.Name))
        {
            IngestFromSourceTree(key);
            return Task.CompletedTask;
        }

        return ReindexOne(metadata, index, gameRelease);
    }

    // The same SourceIngest.Ingest the reconcile's tracked branch runs, so a re-ingest and a first
    // ingest produce the same rows by construction. A failed read is recorded and rethrown, never
    // degraded to the binary.
    private void IngestFromSourceTree(PluginKey key)
    {
        // Outside _lock, always. It takes the gate for itself rather than trusting its caller; the
        // reentrant gate makes that free.
        using var _ = WriteGate.Enter();

        var (metadata, index, gameRelease) = RequireHeldCopy(key);
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
                SourceIngest.Ingest(
                    index, LoadOrderSnapshot.ModFolderOf(metadata.Origin, metadata.Path)!,
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
    }

    private (PluginMetadata Metadata, IRecordIndex Index, GameRelease GameRelease) RequireHeldCopy(PluginKey key)
    {
        lock (_lock)
        {
            var scope = RequireScopeCore();
            var metadata = scope.Held.Find(key)
                ?? throw new KeyNotFoundException($"Plugin '{key.Name}' from '{key.Origin}' is not held.");
            return (metadata, scope.Index, _gameRelease);
        }
    }

    private Task ReindexOne(PluginMetadata metadata, IRecordIndex index, GameRelease gameRelease)
    {
        using var documents = OpenDocuments(metadata, gameRelease, _heldPlugins!.DataFolderPath);

        lock (_lock)
        {
            index.Index(documents, metadata.Registration, metadata.Key, metadata.Path);
            index.UpdateWinners(Participating());
            ReapplyFilter();
        }

        return Task.CompletedTask;
    }

    /// <summary>The file is gone, so its rows go with it. A no-op while the held copy still exists
    /// or with no load order: the watcher that calls this races teardowns and superseding load
    /// orders.</summary>
    public void UnindexPlugin(PluginKey key)
    {
        // The watcher's timer's other index write — a vanished binary — gated like its sibling
        // above. Outside _lock, never inside it.
        using var _ = WriteGate.Enter();

        lock (_lock)
        {
            if (_index == null) return;
            if (_heldPlugins?.Find(key) is { } held && File.Exists(held.Path)) return;

            // Removing a copy is one projection: its rows and the winners they moved.
            using var projection = _index.BeginProjection();

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) is gone from disk; removing it from the index", key.Name, key.Origin);
            }
            _index.Unindex(key);
            // A removal moves winners for every FormKey it held, exactly as a re-index does.
            _index.UpdateWinners(Participating());
            ReapplyFilter();
        }
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
        // or inside the reconcile, which holds _reconcileGate instead. Gating there would newly make
        // a reconcile wait on an edit.
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

    /// <summary>ADR-0014's Refresh: closes the scope, drops the instance's index file and reopens
    /// it empty, flooring the new file's sequence at what this process has already handed out. The
    /// next reconcile fills it.</summary>
    public void RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        var previousSequence = Sequence;
        Close();
        using var rebuilt = _indexFactory.Rebuild(gameRelease, instanceRoot, previousSequence);
    }

    /// <summary>Drops the scope: the copies it has open and the store's connection. Cancels an
    /// in-flight reconcile and waits for it to stop first. The kernel's load order is its own and
    /// is untouched.</summary>
    public void Close()
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
        // Guarded because Dispose owns a semaphore as well as the scope: a second call would
        // otherwise wait on a disposed gate. Double disposal is a supported call pattern here.
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
        }

        EnterExclusive();
        try { lock (_lock) DisposeCurrent(); }
        finally { ExitExclusive(); }
        _reconcileGate.Dispose();
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
    }
}
