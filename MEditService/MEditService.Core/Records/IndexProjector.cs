using System.Diagnostics;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>ADR-0046 invariant 10: the Index's other half. Ingest, the registration sweep and the
/// watchers' re-projections, deciding nothing — the load order value answers who participates and
/// wins, the schema where a field goes.</summary>
public sealed class IndexProjector : IDisposable
{
    private readonly Lock _lock = new();
    private readonly ILogger _logger;
    private readonly IRecordIndexFactory _indexFactory;
    private readonly IModImporter _modImporter;
    // ADR-0046: null in every test that does not care, matching DuckDbRecordIndex's own posture.
    private readonly INotificationPublisher? _notifications;
    // A direct constructor parameter rather than routed through IRecordIndexFactory, which has no
    // other reason to carry it; DI already registers SchemaReflector as its own singleton.
    private readonly SchemaReflector _schemaReflector;
    private HeldPlugins? _heldPlugins;
    private IRecordIndex? _index;
    // The reconcile's own progress. Guarded by _lock like _heldPlugins/_index — written by
    // the reconciling thread as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<IndexedPlugin> _indexed = [];
    private bool _conflictsComputed;
    private int _plannedCount;

    public IndexProjector(
        IRecordIndexFactory indexFactory,
        ILogger? logger = null,
        IModImporter? modImporter = null,
        SchemaReflector? schemaReflector = null,
        INotificationPublisher? notifications = null)
    {
        _indexFactory = indexFactory;
        _logger = logger ?? NullLogger.Instance;
        _modImporter = modImporter ?? new DefaultModImporter();
        _schemaReflector = schemaReflector ?? new SchemaReflector();
        _notifications = notifications;
    }

    // ADR-0044: a copy that failed to open stays a row in an error state until its bytes change.
    // Keyed by the hash the failure was seen against, so mentioning it again never pays the parse
    // twice.
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

    public ILoadOrder? LoadOrder { get { lock (_lock) return _heldPlugins; } }
    public IRecordReads? Reads { get { lock (_lock) return _index?.At(RecordRef.Effective); } }
    public IRecordIndex? Index { get { lock (_lock) return _index; } }

    /// <summary>One per projector, never replaced — a reconcile swaps the store underneath it, which
    /// is when the ordering matters most. By construction the outer of the two locks: taking
    /// <c>_lock</c> first and then waiting here would deadlock.</summary>
    public IndexWriteGate WriteGate { get; } = new();

    /// <summary>See <see cref="ILoadOrderMirror.LoadOrderChanged"/>.</summary>
    public Action? LoadOrderChanged { get; set; }

    // Raised outside _lock and outside the exclusive right, so a subscriber that reads the projector
    // back cannot deadlock against the reconcile that raised it. A throwing subscriber is its own
    // business, never the reconcile's.
    private void AnnounceLoadOrder()
    {
        try
        {
            LoadOrderChanged?.Invoke();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "A load-order subscriber failed; the load order itself is unaffected");
        }
    }

    /// <summary>See <see cref="ILoadOrderMirror.RequireScope"/>.</summary>
    public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope()
    {
        var (loadOrder, index) = RequireScopeCore();
        return (loadOrder, index.At(RecordRef.Effective));
    }

    // The concrete HeldPlugins and write-capable IRecordIndex the projection methods need, not the
    // narrower pair the public method hands out. One lock, one null check, one message.
    private (HeldPlugins LoadOrder, IRecordIndex Index) RequireScopeCore()
    {
        lock (_lock)
        {
            if (_heldPlugins is not { } loadOrder || _index is not { } index)
                throw new NoLoadOrderException();
            return (loadOrder, index);
        }
    }

    /// <summary>Assembled from live state rather than cached, so it cannot drift from the reconcile
    /// it describes; failures come straight off the held copies' own list rather than a second place
    /// that could disagree (ADR-0035).</summary>
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

    // ADR-0046: every site that changes what Status reports calls this after. _lock is reentrant
    // (see ReapplyFilter), so this is safe to call from inside a lock a caller already holds.
    private void PublishStatus() => _notifications?.Publish(new LoadOrderStatusNotification(Status));

    public long Sequence { get { lock (_lock) return _index?.Sequence ?? 0; } }

    /// <summary>ADR-0046: everything projected inside the scope advances the sequence once, when
    /// the outermost of any nested scopes closes. A no-op with no store held.</summary>
    public IDisposable BeginProjection()
    {
        lock (_lock) return _index?.BeginProjection() ?? IndexStore.NoProjectionScope;
    }

    /// <summary>See <see cref="ILoadOrderMirror.Announce"/>.</summary>
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

    /// <summary>ADR-0046 invariant 11: the store's registration rows are made equal to the
    /// snapshot's copies, copies the store has never held are indexed, then one winner sweep.</summary>
    public void Reconcile(LoadOrder snapshot)
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
            var (loadOrder, index) = EnsureScope(snapshot);
            ReconcileProgressively(loadOrder, index, snapshot, token);
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

        AnnounceLoadOrder();
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

    // ADR-0001: the index's home is the MO2 instance — one persistent file per instance, so a fresh
    // open finds whatever the last run left there, and `origin` (a mod folder name) is unique only
    // within one.

    // Published before any plugin is opened, which is what makes the reconcile progressive (ADR-0035).
    private (HeldPlugins LoadOrder, IRecordIndex Index) EnsureScope(LoadOrder snapshot)
    {
        lock (_lock)
        {
            if (_heldPlugins is { } held && _index is { } index && SameScope(held, snapshot))
                return (held, index);
            DisposeCurrent();
        }

        _logger.LogDebug("Initializing DuckDB record index");
        var createTimer = Stopwatch.StartNew();
        var fresh = _indexFactory.Create(snapshot.GameRelease, snapshot.InstanceRoot);
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("DuckDB record index initialized in {ElapsedMs} ms", createTimer.ElapsedMilliseconds);
        }
        var loadOrder = new HeldPlugins(
            snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.GameRelease, _logger);

        lock (_lock)
        {
            _indexed.Clear();
            _failedHashes.Clear();
            _conflictsComputed = false;
            _plannedCount = 0;
            _heldPlugins = loadOrder;
            _index = fresh;
            _gameRelease = snapshot.GameRelease;
        }
        PublishStatus();
        return (loadOrder, fresh);
    }

    private static bool SameScope(HeldPlugins held, LoadOrder snapshot) =>
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
        HeldPlugins loadOrder, IRecordIndex index, LoadOrder snapshot, CancellationToken token)
    {
        var resolved = snapshot.Copies;
        var wanted = resolved.ToDictionary(r => KeyOf(r.Key), StringComparer.OrdinalIgnoreCase);
        var held = loadOrder.Plugins.ToDictionary(p => KeyOf(p.Key), StringComparer.OrdinalIgnoreCase);

        IReadOnlyList<PluginKey> failed;
        lock (_lock) failed = [.. _failedHashes.Values.Select(v => v.Key)];
        // Registered, held, or held only as a failure row — a copy the snapshot has stopped naming
        // leaves by every one of those doors, so a stale error row cannot outlive its copy.
        var leaving = index.RegisteredPlugins()
            .Concat(loadOrder.Plugins.Select(p => p.Key))
            .Concat(failed)
            .Where(k => !wanted.ContainsKey(KeyOf(k)))
            .DistinctBy(KeyOf, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var moved = resolved
            .Where(r => held.TryGetValue(KeyOf(r.Key), out var h) && h.Registration != r.Registration)
            .ToList();
        // A copy in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !held.ContainsKey(KeyOf(r.Key)) && !StillFailing(r)).ToList();

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
            loadOrder.Remove(key);
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
            // ADR-0044: a reorder, an enable, a change of which copy wins — all the same SQL-only
            // move: no re-read, no re-index, so it is safe to apply live and unprompted.
            var metadata = loadOrder.Update(held[KeyOf(plugin.Key)], plugin.Registration);
            index.Register(metadata.Key, metadata.Registration);
        }

        // Two numbers ADR-0035 makes distinct — time to the first queryable plugin (the tree
        // becomes usable) and time to the winner sweep completing. Measured here rather than
        // client-side, where the 500 ms status poll caps the resolution.
        var timer = Stopwatch.StartNew();
        long? firstUsableMs = null;

        // One at a time: opening the whole set first would cost the same total time but make every
        // plugin wait on the slowest before any could be indexed, and bury each open failure.
        foreach (var plugin in arriving)
        {
            // At the top of each plugin rather than mid-plugin: a plugin is indexed in one
            // transaction, so abandoning it partway would roll back work already paid for or leave
            // half-written state.
            token.ThrowIfCancellationRequested();

            if (loadOrder.Open(plugin) is not { } metadata)
            {
                lock (_lock) _failedHashes[KeyOf(plugin.Key)] = (plugin.Key, PluginBinaryHash.OfFile(plugin.Path));
                continue;
            }
            lock (_lock) _failedHashes.Remove(KeyOf(plugin.Key));

            RegisterOrIndex(loadOrder, index, metadata, token);
            firstUsableMs ??= timer.ElapsedMilliseconds;
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0035).
        _logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        index.UpdateWinners();
        lock (_lock) _conflictsComputed = true;
        // Ready: the last status transition a subscriber sees for this reconcile.
        PublishStatus();
        // Any of the above can change which records match an active filter.
        ReapplyFilter();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Load order reconciled in {TotalMs} ms: {Arrived} arrived, {Moved} moved, {Left} left, {Held} held (first plugin usable after {FirstUsableMs} ms, winner sweep {WinnersMs} ms)",
                timer.ElapsedMilliseconds, arriving.Count, moved.Count, leaving.Count, loadOrder.Plugins.Count,
                firstUsableMs, winnersTimer.ElapsedMilliseconds);
        }
    }

    // Registers first: the index's reads are scoped by registration, so validate would otherwise
    // compare an empty row set against a full tree. False falls through to a full index.
    private bool WarmRegister(IRecordIndex index, PluginMetadata plugin, string? sourceTree)
    {
        index.Register(plugin.Key, plugin.Registration);

        // An untracked copy's binary was already hashed against its stored claim when the index file
        // opened (IndexStore.ValidateAgainstDisk), so a second hash of every binary here would pay
        // that whole cost twice for no new answer.
        if (sourceTree == null) return true;

        try
        {
            var report = index.Validate(plugin.Key, ModFolders.Of(plugin.Origin, plugin.Path));
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

    // ADR-0001: a copy the index has already seen is registered rather than indexed — a non-null
    // content hash means "held, and still matching the bytes on disk".

    // ADR-0046 invariant 6: a tracked copy takes the same warm path, its source tree validated by
    // content where the untracked branch checked the binary hash at open. Only a moved document set
    // is re-derived whole.

    // The tree is resolved here because the register/index decision needs the answer the ingest does.
    private void RegisterOrIndex(HeldPlugins loadOrder, IRecordIndex index, PluginMetadata plugin, CancellationToken token)
    {
        var key = plugin.Key;
        var sourceTree = SourceIngest.TreeFor(plugin.Origin, plugin.Path, plugin.Name);
        if (index.IndexedContentHash(key) != null && WarmRegister(index, plugin, sourceTree))
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
            // ADR-0036: threads the origin into the index, so the DuckDB row is identified
            // by (origin, plugin) together, not filename alone.
            IndexOnePlugin(loadOrder, index, plugin, loadOrder.GetMod(plugin.Name, plugin.Origin)!, sourceTree, token);
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
            loadOrder.SetFailure(key, PluginLoadFailure.ReasonFor(ex));
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

    // Where a plugin's records come from (ADR-0041): a tracked plugin's source tree, the binary for
    // everything else. Both branches end in the same Index call, which is what keeps the read model
    // free of a dialect.

    // The binary is still opened for a tracked plugin — HeldPlugins reads the overlay for metadata and
    // the write path builds its link cache from it. What this establishes is only "never consult the
    // binary for a tracked plugin's content".

    // Moving masters and record count onto the tree as well is a further step, not this one: it
    // would reach into HeldPlugins' mod registry and the save path.

    // A failed source read degrades to the binary, but records a real PluginLoadFailure: a silent
    // fallback would leave the user reading pre-Track binary content believing it was their source.
    private void IndexOnePlugin(
        HeldPlugins loadOrder, IRecordIndex index, PluginMetadata plugin,
        IModGetter binary, string? sourceTree, CancellationToken token)
    {
        // One advance for the whole copy, whichever door it came through (ADR-0046).
        using var _ = index.BeginProjection();

        if (sourceTree == null)
        {
            index.Index(binary, plugin.Registration, plugin.Key, plugin.Path);
            return;
        }

        try
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Ingesting {Plugin} from its source tree ({Tree})", plugin.Name, sourceTree);
            }
            SourceIngest.Ingest(
                index, ModFolders.Of(plugin.Origin, plugin.Path)!, sourceTree,
                plugin.Registration, plugin.Key, plugin.Path, loadOrder.GameRelease,
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
            loadOrder.SetFailure(plugin.Key,
                $"Could not read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Showing the " +
                "compiled binary instead — edits made since the last compile are not reflected.");
        }

        index.Index(binary, plugin.Registration, plugin.Key, plugin.Path);
    }

    /// <summary>ADR-0041: nothing here touches plugins.txt — Mod Management owns that file, and the
    /// append happens only once this call has succeeded, so the load order can never name a file
    /// this method did not finish writing.</summary>
    public PluginResponse CreatePlugin(string name, string path, string origin)
    {
        // This indexes a whole new plugin, so it is a write like any other. _lock alone would not
        // order it against an in-flight edit: the edit path writes through IRecordIndex without
        // holding _lock at all.
        using var _ = WriteGate.Enter();

        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Plugin name cannot be empty.", nameof(name));
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Destination path cannot be empty.", nameof(path));
        if (string.IsNullOrWhiteSpace(origin))
            throw new ArgumentException("Origin cannot be empty.", nameof(origin));

        var ext = Path.GetExtension(name);
        if (!ext.Equals(".esp", StringComparison.OrdinalIgnoreCase) &&
            !ext.Equals(".esm", StringComparison.OrdinalIgnoreCase) &&
            !ext.Equals(".esl", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException($"Invalid plugin extension '{ext}'. Must be .esp, .esm, or .esl.", nameof(name));
        }

        lock (_lock)
        {
            var (loadOrder, index) = RequireScopeCore();

            // Never-assume-exclusive-ownership: the destination may be a mod folder nothing has
            // written into yet — a brand-new mod, or overwrite/ before its first file.
            Directory.CreateDirectory(path);

            var filePath = Path.Combine(path, name);
            if (File.Exists(filePath))
                throw new IOException($"Plugin file already exists: {name}");

            var modKey = ModKey.FromFileName(name);
            var mod = ModFactory.Activator(modKey, _gameRelease);
            // A new plugin defaults to an ESL-flagged ESP, silently; the flag is an ordinary
            // editable header field afterward. Only for a caller-named .esp: an explicit .esl is
            // already light, and an explicit .esm asked for a full master.
            if (Path.GetExtension(name).Equals(".esp", StringComparison.OrdinalIgnoreCase))
            {
                mod.IsSmallMaster = true;
            }
            mod.WriteToBinary(filePath);

            var metadata = loadOrder.AddCreatedPlugin(filePath, origin);
            var openedMod = loadOrder.GetMod(metadata.Name, metadata.Origin)!;
            index.Index(openedMod, metadata.Registration, metadata.Key, metadata.Path);
            _indexed.Add(new IndexedPlugin(metadata.Name, metadata.Origin));
            PublishStatus();
            // A whole new plugin's rows can newly match an active filter.
            ReapplyFilter();
            return PluginResponse.FromMetadata(metadata);
        }
    }

    /// <summary>See <see cref="ILoadOrderMirror.ValidateIndex"/>.</summary>
    public IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin)
    {
        // Outside _lock, as every mutation door here is: validate refreshes rows through the index's
        // own verbs, and the gate is reentrant so the rebuild below can take it again.
        using var _ = WriteGate.Enter();

        var (loadOrder, index) = RequireHeldIndex();
        // One advance for everything this validate re-derives, however many copies it names.
        using var projection = index.BeginProjection();
        var keys = plugin is { } one ? (IReadOnlyList<PluginKey>)[one] : index.RegisteredPlugins();

        var order = Plugins.LoadOrder.From(loadOrder);
        var reports = new List<ValidationReport>(keys.Count);
        foreach (var key in keys)
        {
            var report = index.Validate(key, ModFolders.Of(order, key));
            foreach (var failure in report.Failures)
                _logger.LogWarning("Reconciling {Plugin}: {Failure}", key.Name, failure);

            // A record set that moved is a whole-plugin re-derivation, which is the projector's to
            // run: it holds the mod and knows which truth this copy reads (ADR-0041).
            if (report.NeedsRebuild) ReindexPlugin(key).GetAwaiter().GetResult();
            reports.Add(report);
        }

        // Any of the above can change which records match an active filter.
        ReapplyFilter();
        return reports;
    }

    /// <summary>See <see cref="ILoadOrderMirror.RefreshKeys"/>.</summary>
    public void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys)
    {
        // Taken before anything reaches _lock or the index: this runs on the Source watcher's timer,
        // with nothing else ordering it against an in-flight edit.
        using var _ = WriteGate.Enter();

        var (loadOrder, index) = RequireHeldIndex();
        // Every key named here is one logical write, so it lands as one advance.
        using var projection = index.BeginProjection();

        // Re-derived every call, never remembered from when the watch started: the repository can be
        // deleted or replaced between the event and this line, and then there is no truth to read.
        if (ModFolders.TrackedOf(Plugins.LoadOrder.From(loadOrder), key) is not { } modFolder) return;

        index.RefreshByKeys(key, modFolder, formKeys);
        ReapplyFilter();
    }

    // Never null, and never one without the other, for the same reason RequireScope is not.
    private (ILoadOrder LoadOrder, IRecordIndex Index) RequireHeldIndex()
    {
        lock (_lock)
        {
            if (_heldPlugins == null || _index == null) throw new NoLoadOrderException();
            return (_heldPlugins, _index);
        }
    }

    /// <summary>See <see cref="ILoadOrderMirror.ReindexPlugin(PluginKey)"/>.</summary>
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
        // ADR-0046: a whole copy re-derived is one projection, so it is one advance whichever
        // branch below runs.
        using var projection = index.BeginProjection();

        // A tracked copy's truth is its source tree, so it is re-derived from there and its binary
        // is never opened.

        // Asked here as a bare "is this tracked" question; the door below resolves the tree it reads
        // for itself, so neither trusts the other about a folder either could have lost in between.
        if (SourceIngest.TreeFor(metadata.Origin, metadata.Path, metadata.Name) != null)
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
        var sourceTree = SourceIngest.TreeFor(metadata.Origin, metadata.Path, metadata.Name)
            ?? throw new InvalidOperationException(
                $"Plugin '{key.Name}' from '{key.Origin}' has no source tree to re-ingest; it is not tracked.");

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Re-ingesting {Plugin} from its source tree ({Tree})", metadata.Name, sourceTree);
        }

        // Under _lock, unlike the reconcile's own ingest: this fires against a live index that every
        // other mutation door is serialized against by this same lock.
        lock (_lock)
        {
            try
            {
                SourceIngest.Ingest(
                    index, ModFolders.Of(metadata.Origin, metadata.Path)!, sourceTree,
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

            index.UpdateWinners();
            // Re-derived content can flip filter membership either way.
            ReapplyFilter();
        }
    }

    private (PluginMetadata Metadata, IRecordIndex Index, GameRelease GameRelease) RequireHeldCopy(PluginKey key)
    {
        lock (_lock)
        {
            var scope = RequireScopeCore();
            var metadata = scope.LoadOrder.Find(key)
                ?? throw new KeyNotFoundException($"Plugin '{key.Name}' from '{key.Origin}' is not held.");
            return (metadata, scope.Index, _gameRelease);
        }
    }

    private Task ReindexOne(PluginMetadata metadata, IRecordIndex index, GameRelease gameRelease)
    {
        var modKey = ModKey.FromFileName(Path.GetFileName(metadata.Path));
        var modPath = new ModPath(modKey, metadata.Path);
        using var loaded = _modImporter.Import(
            modPath, gameRelease, LocalizedStrings.ForRead(ModFolders.Of(metadata.Origin, metadata.Path), _heldPlugins!.DataFolderPath));

        lock (_lock)
        {
            index.Index(loaded.Getter, metadata.Registration, metadata.Key, metadata.Path);
            index.UpdateWinners();
            // Re-indexed content can flip filter membership either way.
            ReapplyFilter();
        }

        return Task.CompletedTask;
    }

    /// <summary>See <see cref="ILoadOrderMirror.UnindexPlugin"/>.</summary>
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
            _index.UpdateWinners();
            // Deleted rows cannot match a filter that a stale _filter still lists them in.
            ReapplyFilter();
        }
    }

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
            var (loadOrder, index) = RequireScopeCore();
            index.SetFilter(sql);
            loadOrder.FilterSql = sql;
        }
    }

    // `_lock` is reentrant, so every projection path calls this from inside the lock scope it
    // already holds around its own Index/UpdateWinners calls rather than dropping and retaking it.
    public void ReapplyFilter()
    {
        lock (_lock)
        {
            if (_heldPlugins?.FilterSql is not { } sql || _index is null) return;
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

    public void Close()
    {
        // Cancels an in-flight reconcile and waits for it to stop *before* disposing anything —
        // the teardown half of the cancellation. Disposing while the loop still holds the
        // index is a native crash, not a catchable one.
        EnterExclusive();
        try { lock (_lock) DisposeCurrent(); }
        finally { ExitExclusive(); }

        PublishStatus();
        AnnounceLoadOrder();
    }

    public void Dispose()
    {
        // Guarded because Dispose owns a semaphore as well as the load order: a second call would
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
        _heldPlugins?.Dispose();
        _heldPlugins = null;
        _index?.Dispose();
        _index = null;
        _indexed.Clear();
        _failedHashes.Clear();
        _conflictsComputed = false;
        _plannedCount = 0;
    }
}
