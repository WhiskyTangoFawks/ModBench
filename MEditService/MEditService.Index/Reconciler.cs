using System.Diagnostics;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index;

/// <summary>Brings the Store to the load order (ADR-0013), then validates every plugin against its
/// system of record (ADR-0003). It holds the plugins open, the progress Status reports and the
/// scope the Store is opened for.</summary>
internal sealed class Reconciler(
    LoadOrderHolder holder,
    IPluginAdapter adapter,
    DuckDbRecordIndexFactory indexFactory,
    FilterInForce filter,
    ILogger logger,
    INotificationPublisher? notifications,
    TimeProvider timeProvider) : IDisposable
{
    // Lock order: _lock, then the Store's projection lock, which a projection's announcements run
    // under. An announcement reads the index's own Sequence, never this class's Sequence, Status or
    // RequireReads, which take _lock.
    private readonly Lock _lock = new();
    private OpenScope? _scope;

    // The reconcile's own progress. Guarded by _lock like _scope: written by the reconciling thread
    // as each plugin lands, read by whoever asks for Status meanwhile.
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
    // The version the reconcile door last finished answering for: never a superseded attempt's,
    // since that one returns before reaching its own update.
    private long _version;

    // Two mechanisms, because one is not enough: the token asks the reconcile loop to stop, the
    // exclusive lock waits until it has. Cancelling without draining would let a teardown dispose
    // the DuckDB connection mid-write, a native crash.

    // Deliberately not _lock: the reconciling thread takes _lock on every plugin, so a waiter
    // holding it could never be signalled.
    private readonly Lock _exclusive = new();
    private CancellationTokenSource? _reconcileCancellation;
    private bool _disposed;

    /// <summary>One per Reconciler, never replaced: a reconcile swaps the store underneath it, which
    /// is when the ordering matters most. By construction the outer of the two locks: taking
    /// _lock first and then waiting here would deadlock.</summary>
    internal IndexWriteGate WriteGate { get; } = new();

    private sealed record OpenScope(HeldPlugins Held, DuckDbRecordIndex Index, Projector Projector, FailedReads Failed);

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

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: before the first reconcile
    /// the Index has opened no store to read.</summary>
    public IRecordReads RequireReads() => RequireScope().Index.Reads;

    private OpenScope RequireScope()
    {
        lock (_lock) return _scope ?? throw new NoLoadOrderException();
    }

    /// <summary>Runs <paramref name="action"/> under the lock that disposing the scope takes, so the
    /// index cannot be closed beneath it. False, having run nothing, with no scope held.</summary>
    internal bool UnderScope(Action<DuckDbRecordIndex, IndexScope> action)
    {
        lock (_lock)
        {
            if (_scope is not { } scope) return false;
            action(scope.Index, IndexScope.Of(scope.Held));
            return true;
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
                // Whatever this attempt still holds, usually nothing, since a refused open leaves
                // EnsureScope holding nothing new, with State/Message overlaid rather than
                // discarded, so a mid-reconcile unknown failure keeps reporting what had landed.
                LoadOrderStatus held;
                if (_scope is null)
                {
                    held = LoadOrderStatus.None with { Version = _version };
                }
                else
                {
                    var state = _conflictsComputed && !_validating ? LoadOrderState.Ready : LoadOrderState.Reconciling;
                    held = new LoadOrderStatus(state, _plannedCount, _activeCount, [.. _indexed], _conflictsComputed, _scope.Held.Failures, Version: _version);
                }

                if (_heldElsewhereMessage is { } heldElsewhere)
                    return held with { State = LoadOrderState.HeldElsewhere, Message = heldElsewhere };
                if (_failureMessage is { } failure)
                    return held with { State = LoadOrderState.Failed, Message = failure };
                return held;
            }
        }
    }

    // ADR-0015: every site that changes what Status reports calls this after. _lock is reentrant,
    // so this is safe to call from inside a lock a caller already holds.
    private void PublishStatus() => notifications?.Publish(new LoadOrderStatusNotification(Status));

    public long Sequence { get { lock (_lock) return _scope?.Index.Sequence ?? 0; } }

    // ADR-0015: a whole plugin re-derived or removed has too many rows to name, so the
    // announcement names the plugin and the sequence the store reached once the projection landed.
    private void AnnouncePluginChanged(DuckDbRecordIndex index, PluginAddress key) =>
        index.Announce(() => notifications?.Publish(new PluginChangedNotification(key, index.Sequence)));

    // Polling, not the notification port: this answers one caller's own bound, not every
    // subscriber, and every write already serializes through IndexWriteGate, so a short poll
    // answers within one interval of landing.
    private static readonly TimeSpan SequencePollInterval = TimeSpan.FromMilliseconds(20);

    /// <summary>Polls <see cref="Sequence"/> until it reaches <paramref name="atLeast"/> or
    /// <paramref name="timeout"/> elapses on the injected clock. True the moment it lands; false,
    /// never a throw, on a timeout: the answer is "not yet".</summary>
    public async Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout)
    {
        var deadline = timeProvider.GetUtcNow() + timeout;
        while (true)
        {
            if (Sequence >= atLeast) return true;
            var remaining = deadline - timeProvider.GetUtcNow();
            if (remaining <= TimeSpan.Zero) return false;
            await Task.Delay(remaining < SequencePollInterval ? remaining : SequencePollInterval, timeProvider).ConfigureAwait(false);
        }
    }

    /// <summary>Reconciles every arrival of the load order, changed or not, on a thread of its own
    /// (ADR-0013): the snapshot held when it runs, so an overtaken arrival reconciles
    /// the newer.</summary>
    public Task StartReconcile() =>
        Task.Factory.StartNew(ReconcileHeld, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    // Disposal is read with the exclusive right held, which Dispose takes after setting it, so no
    // reconcile opens a store after Dispose.
    private void ReconcileHeld() => Reconcile(() =>
    {
        lock (_lock) return _disposed ? null : holder.Held;
    });

    // ADR-0013's one verb, then every plugin validated (ADR-0003). The arrival is read once the
    // exclusive right is held, so a refill reconciles the load order held then. Null reconciles
    // nothing.
    private void Reconcile(Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival)
    {
        long version = 0;
        bool changed;
        string? heldElsewhere = null;
        string? failure = null;
        try
        {
            if (ReconcileOrRefuse(arrival, ref version, ref heldElsewhere, ref failure) is not { } reconciled) return;
            changed = reconciled;
        }
        catch (OperationCanceledException)
        {
            // Superseded: the reconcile that cancelled this one answers for this version or
            // higher, so nothing here is ever the last word for it.
            return;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // ReconcileOrRefuse already logged this at error; there is nothing further up to raise
            // it to, so it becomes status data instead of only a log line.
            failure = ex.Message;
            changed = true;
        }
        // Max, not assign: the exclusive lock is released before this runs, so a newer version's
        // own stamp can land first, and this one must never answer for it downward.
        lock (_lock)
        {
            if (heldElsewhere is not null) _heldElsewhereMessage = heldElsewhere;
            if (failure is not null) _failureMessage = failure;
            changed |= version > _version;
            _version = Math.Max(_version, version);
            _validating = false;
            if (changed) PublishStatus();
        }
    }

    // A superseded reconcile throws OperationCanceledException, leaving its work for its
    // successor; a second window's hold is answered in heldElsewhere. Null when the arrival
    // resolved to none, and false when the reconcile changed nothing Status reports.
    private bool? ReconcileOrRefuse(
        Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival, ref long version,
        ref string? heldElsewhere, ref string? failure)
    {
        EnterExclusive();
        try
        {
            if (arrival() is not { } resolved) return null;
            var (snapshot, arrived) = resolved;
            version = arrived;
            if (logger.IsEnabled(LogLevel.Debug))
            {
                logger.LogDebug("Reconciling load order. GameDir={GameDir} Instance={Instance} Plugins={Count} Game={Game}",
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
            if (EnsureScope(snapshot, out heldElsewhere) is not { } scope)
            {
                // Refused, not failed: the user has two windows on one instance, and nothing is
                // held here (EnsureScope tore the previous scope down before the open that refused).
                return true;
            }
            var reconciled = ReconcileProgressively(scope, snapshot, token) || refusalCleared;
            failure = ValidateHeld(token);
            return failure is not null || reconciled;
        }
        catch (OperationCanceledException ex)
        {
            // Superseded: whatever landed stays held and registered, and the reconcile that
            // cancelled this one owns the rest. Normal, not a failure: Information, not Warning.
            logger.LogInformation(ex, "Load order reconcile was superseded before it completed");
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Load order reconcile failed");
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
    private OpenScope? EnsureScope(LoadOrderSnapshot snapshot, out string? heldElsewhere)
    {
        heldElsewhere = null;
        lock (_lock)
        {
            if (_scope is { } current && IndexScope.Of(current.Held).Matches(snapshot)) return current;
            DisposeCurrent();
            filter.DropWhenOutside(snapshot);
        }

        logger.LogDebug("Initializing DuckDB record index");
        var createTimer = Stopwatch.StartNew();
        var held = new HeldPlugins(
            adapter, snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.GameRelease, logger);
        DuckDbRecordIndex? fresh = null;
        OpenScope scope;
        try
        {
            fresh = indexFactory.Create(
                snapshot.GameRelease, snapshot.InstanceRoot, () => held.OpenedPlugins, out heldElsewhere);
            if (fresh is null) return null;
            scope = new OpenScope(held, fresh, new Projector(fresh, held.Find, notifications, logger), new FailedReads(fresh));
            fresh = null;
        }
        finally
        {
            fresh?.Dispose();
        }
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug("DuckDB record index initialized in {ElapsedMs} ms", createTimer.ElapsedMilliseconds);
        }

        lock (_lock)
        {
            _indexed.Clear();
            _conflictsComputed = false;
            _plannedCount = 0;
            _activeCount = 0;
            _scope = scope;
            filter.Reapply(scope.Index);
        }
        PublishStatus();
        return scope;
    }

    // The diff is computed first and without side effects (one stamp read and a folder probe per
    // plugin), so a snapshot that moves nothing writes nothing and publishes no status.

    // Registrations the snapshot has stopped naming are dropped before anything new is opened, so a
    // freshly opened index file's last-run rows stop answering as early as possible. False when the
    // snapshot moved nothing.
    private bool ReconcileProgressively(OpenScope scope, LoadOrderSnapshot snapshot, CancellationToken token)
    {
        var (held, index) = (scope.Held, scope.Index);
        var resolved = snapshot.Plugins;
        var wanted = resolved.ToDictionary(r => r.Key, PluginAddress.Comparer);
        var open = held.Plugins.ToDictionary(p => p.Key, PluginAddress.Comparer);

        // Registered, held, or held only as a failure row: a plugin the snapshot has stopped naming
        // leaves by every one of those doors, so a stale error row cannot outlive its plugin.
        var leaving = index.RegisteredPlugins()
            .Concat(held.Plugins.Select(p => p.Key))
            .Concat(scope.Failed.Keys)
            .Where(k => !wanted.ContainsKey(k))
            .Distinct(PluginAddress.Comparer)
            .ToList();
        var moved = resolved
            .Select(r => r.Key)
            .Where(key => open.TryGetValue(key, out var h) && h.Registration != snapshot.RegistrationOf(key))
            .ToList();
        // A plugin in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !open.ContainsKey(r.Key) && !scope.Failed.StillFailing(r.Key, r.Path)).ToList();
        // ADR-0007: which truth a plugin reads is its folder's answer, and the stamp
        // records the one its rows came from. Tracking and untracking move the first alone, and no
        // load-order difference above names them.
        var stampedFromSource = index.Reads.GetTrackedPlugins();
        var reDerived = resolved.Where(r => open.ContainsKey(r.Key) && TruthMoved(scope, r, stampedFromSource)).ToList();

        bool conflictsComputed;
        lock (_lock) conflictsComputed = _conflictsComputed;
        if (leaving.Count == 0 && moved.Count == 0 && arriving.Count == 0 && reDerived.Count == 0 && conflictsComputed)
        {
            logger.LogDebug("Load order snapshot is identical to what is held; nothing to reconcile");
            return false;
        }

        lock (_lock)
        {
            _conflictsComputed = false;
            _validating = true;
            _plannedCount = resolved.Count;
            _activeCount = snapshot.Active.Count;
        }
        // Reconciling begins here, with the total known: the first status a subscriber sees for
        // this reconcile.
        PublishStatus();

        foreach (var key in leaving)
        {
            index.Unregister(key);
            held.Remove(key);
            lock (_lock) _indexed.RemoveAll(i => PluginAddress.Comparer.Equals(new PluginAddress(i.Name, i.Origin), key));
            scope.Failed.Forget(key);
        }
        if (leaving.Count > 0) PublishStatus();

        foreach (var key in moved)
        {
            // ADR-0012.
            index.Register(held.Update(open[key], snapshot.RegistrationOf(key)));
        }

        ReDeriveMovedTruths(scope, reDerived, token);

        // Two distinct numbers: time to the first queryable plugin (the tree becomes usable) and
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
                scope.Failed.Remember(plugin.Key, plugin.Path);
                continue;
            }
            scope.Failed.Forget(plugin.Key);

            RegisterOrIndex(scope, metadata, token);
            // A plugin is browsable the moment it lands, so the rows the filter matches in it must
            // answer then too, not only after the whole set (plugins.md, Order and view state).
            filter.Reapply(index);
            firstUsableMs ??= timer.ElapsedMilliseconds;
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0013).
        logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        index.UpdateWinners(snapshot.Active);
        lock (_lock) _conflictsComputed = true;
        // Ready itself publishes from the reconcile door, once this version is stamped in.
        filter.Reapply(index);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Load order reconciled in {TotalMs} ms: {Arrived} arrived, {Moved} moved, {Left} left, {Held} held (first plugin usable after {FirstUsableMs} ms, winner sweep {WinnersMs} ms)",
                timer.ElapsedMilliseconds, arriving.Count, moved.Count, leaving.Count, held.Plugins.Count,
                firstUsableMs, winnersTimer.ElapsedMilliseconds);
        }
        return true;
    }

    // A plugin that failed the last re-derivation is not read again until what it reads from changes.
    private static bool TruthMoved(OpenScope scope, RegisteredPlugin plugin, IReadOnlySet<PluginAddress> stampedFromSource)
    {
        var holdsTree = Projector.HoldsTree(plugin.Key, plugin.Path);
        return holdsTree != stampedFromSource.Contains(plugin.Key) && !scope.Failed.StillFailing(plugin.Key, plugin.Path);
    }

    // A plugin whose folder was tracked or untracked since it was indexed. Nothing here has compared
    // the two truths, so the plugin is re-derived whole from the one its folder now offers.
    private void ReDeriveMovedTruths(OpenScope scope, IReadOnlyList<RegisteredPlugin> plugins, CancellationToken token)
    {
        foreach (var plugin in plugins)
        {
            token.ThrowIfCancellationRequested();
            if (scope.Held.Find(plugin.Key) is not { } metadata) continue;

            var holdsTree = Projector.HoldsTree(plugin.Key, plugin.Path);
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "{Plugin} ({Origin}) now reads from {Truth}; re-deriving it", plugin.Name, plugin.Origin,
                    holdsTree ? "its source tree" : "its binary");
            }
            try
            {
                IndexOnePlugin(scope, metadata, holdsTree, token);
                scope.Failed.Forget(plugin.Key);
            }
            catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
            {
                // plugins.md, A row, Plugin: one plugin that cannot be read is that row's "Failed to
                // read", never the whole index's failure.
                logger.LogWarning(ex, "Failed to re-derive {Plugin} ({Origin})", plugin.Name, plugin.Origin);
                FailRead(scope, plugin.Key, plugin.Path, PluginLoadFailure.ReasonFor(ex));
            }
        }
    }

    // Registers first: the index's reads are scoped by registration, so validate would otherwise
    // compare an empty row set against a full tree. False falls through to a full index.
    private bool WarmRegister(OpenScope scope, PluginMetadata plugin, bool holdsTree)
    {
        scope.Index.Register(plugin);

        // An untracked plugin's binary was already hashed against its stored claim when the index file
        // opened (Store.ValidateAgainstDisk), so a second hash of every binary here would pay
        // that whole cost twice for no new answer.
        if (!holdsTree) return true;

        try
        {
            var report = scope.Projector.Validate(plugin.Key, LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path));
            foreach (var failure in report.Failures)
                logger.LogWarning("Validating {Plugin} at load: {Failure}", plugin.Name, failure);
            return !report.NeedsRebuild;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException
            or NotSupportedException)
        {
            // A tree that cannot be read is no evidence the rows are still true, and the ingest below
            // reports its own failure properly (a source read is never degraded to the binary silently).
            logger.LogWarning(ex, "Could not validate {Plugin}'s source tree at load; re-deriving it", plugin.Name);
            return false;
        }
    }

    // A failure that says what the plugin already said publishes nothing.
    private void FailRead(OpenScope scope, PluginAddress key, string path, string reason)
    {
        var told = scope.Held.SetFailure(key, reason);
        scope.Failed.Remember(key, path);
        if (told) PublishStatus();
    }

    // A file another process held is read again at the next snapshot, whatever it reads from.
    private void FailReadUntilTheNextSnapshot(OpenScope scope, PluginAddress key, string reason)
    {
        var told = scope.Held.SetFailure(key, reason);
        scope.Failed.RememberUntilTheNextSnapshot(key);
        if (told) PublishStatus();
    }

    // ADR-0010: a plugin the store has seen, still matching the disk, is registered, not
    // indexed; ADR-0015 validates a tracked plugin by content on that same warm path.
    private void RegisterOrIndex(OpenScope scope, PluginMetadata plugin, CancellationToken token)
    {
        var key = plugin.Key;
        var holdsTree = Projector.HoldsTree(plugin.Key, plugin.Path);
        if (scope.Index.IndexedContentHash(key) != null && WarmRegister(scope, plugin, holdsTree))
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "Registering {Plugin} ({RecordCount} records), already indexed and unchanged on disk",
                    plugin.Name, plugin.RecordCount);
            }
            // Counted exactly as an indexed plugin is: Status promises a plugin listed here is
            // wholly queryable, and a registered one is.
            lock (_lock) _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
            PublishStatus();
            return;
        }

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
        }
        var indexTimer = Stopwatch.StartNew();
        try
        {
            IndexOnePlugin(scope, plugin, holdsTree, token);
            if (logger.IsEnabled(LogLevel.Debug))
            {
                logger.LogDebug("Indexed {Plugin} in {ElapsedMs} ms", plugin.Name, indexTimer.ElapsedMilliseconds);
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
            logger.LogWarning(ex, "Failed to index {Plugin}; its records will not be queryable", plugin.Name);
            FailRead(scope, key, plugin.Path, PluginLoadFailure.ReasonFor(ex));
            return;
        }

        // Recorded only once Index() has returned: Status promises a plugin here is wholly
        // queryable, so listing it any earlier would be the partial-visibility lie in a
        // different form.
        lock (_lock) _indexed.Add(new IndexedPlugin(plugin.Name, plugin.Origin));
        PublishStatus();
    }

    // ADR-0007; HeldPlugins still reads a tracked plugin's metadata off its binary.

    // A failed source read degrades to the binary, but records a real PluginLoadFailure: a silent
    // fallback would leave the user reading pre-Track binary content believing it was their source.
    private void IndexOnePlugin(OpenScope scope, PluginMetadata plugin, bool holdsTree, CancellationToken token)
    {
        // One advance for the whole plugin, whichever door it came through (ADR-0015).
        using var _ = scope.Index.BeginProjection();

        if (!holdsTree)
        {
            IndexFromBinary(scope, plugin);
            return;
        }

        try
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Ingesting {Plugin} from its source tree", plugin.Name);
            }
            scope.Projector.Ingest(plugin, ModFolderHoldingTree(plugin), token);
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
            logger.LogWarning(ex,
                "Could not ingest {Plugin} from its source tree; falling back to the binary", plugin.Name);
            scope.Held.SetFailure(plugin.Key,
                $"Could not read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Showing the " +
                "compiled binary instead — edits made since the last compile are not reflected.");
            scope.Failed.Remember(plugin.Key, plugin.Path);
        }

        IndexFromBinary(scope, plugin);
    }

    private static string ModFolderHoldingTree(PluginMetadata plugin) =>
        LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path)
            ?? throw new InvalidOperationException(
                $"'{plugin.Name}' from '{plugin.Origin}' holds a source tree, so its origin is neither the game's own Data directory nor Overwrite.");

    // ADR-0005: the binary reaches the index as documents, through the adapter's own door,
    // never as a mod this side holds.
    private void IndexFromBinary(OpenScope scope, PluginMetadata plugin)
    {
        using var documents = OpenDocuments(scope, plugin);
        scope.Index.Index(documents, plugin, plugin.Path, DerivedFrom.Binary);
    }

    private IPluginDocuments OpenDocuments(OpenScope scope, PluginMetadata plugin) =>
        adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(Path.GetFileName(plugin.Path)), plugin.Path),
            scope.Index.Release,
            scope.Index.Schemas,
            new PluginStrings(LoadOrderSnapshot.FileFolderOf(plugin.Path), scope.Held.DataFolderPath));

    // ADR-0015.
    private void ValidateIndex(CancellationToken token)
    {
        // Outside _lock, as every mutation door here is: validate refreshes rows through the index's
        // own verbs, and the gate is reentrant so the rebuild below can take it again.
        using var _ = WriteGate.Enter();

        var scope = RequireScope();
        // One advance for everything this validate re-derives.
        using var projection = scope.Index.BeginProjection();
        // A plugin not held failed to open, and the reconcile opens it again once its bytes change.
        foreach (var metadata in scope.Held.Plugins)
        {
            token.ThrowIfCancellationRequested();
            ValidateOne(scope, metadata);
        }

        filter.Reapply(scope.Index);
    }

    // plugins.md, A row, Plugin, "Failed to read": a plugin that cannot be read is flagged, and the
    // rest are still validated. A failed one is read whole again once what it reads from changed.
    private void ValidateOne(OpenScope scope, PluginMetadata plugin)
    {
        var (held, index) = (scope.Held, scope.Index);
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
                if (!scope.Failed.StillFailing(key, plugin.Path)) ReindexHeldPlugin(key);
                return;
            }

            var report = scope.Projector.Validate(key, modFolder);
            if (report.Failures.Count > 0)
            {
                foreach (var failure in report.Failures)
                    logger.LogWarning("Reconciling {Plugin}: {Failure}", key.Name, failure);
                FailRead(scope, key, plugin.Path, ValidationFailure(holdsTree, string.Join("; ", report.Failures)));
                return;
            }

            // Gained records are refreshed by key so the rows that moved are named (ADR-0015).
            if (report.NeedsRebuild && report.ChangedKeys.Count > 0 && modFolder is { } folder)
            {
                RefreshByKeysOrReadWhole(scope, key, folder, report.ChangedKeys);
            }
            // An untracked plugin's rows went with its file, and the file is back.
            else if (report.NeedsRebuild || (!holdsTree && index.IndexedContentHash(key) is null))
            {
                ReindexHeldPlugin(key);
            }
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            logger.LogWarning(ex, "Could not validate {Plugin} ({Origin})", key.Name, key.Origin);
            // A re-read that failed has named its own failure.
            if (!held.IsHeldWithAFailure(key))
            {
                var reason = ValidationFailure(holdsTree, PluginLoadFailure.ReasonFor(ex));
                if (ex is IOException or UnauthorizedAccessException) FailReadUntilTheNextSnapshot(scope, key, reason);
                else FailRead(scope, key, plugin.Path, reason);
            }
        }
    }

    // editor.md, States, story 6: the rows stay the last good read, and say why.
    private static string ValidationFailure(bool holdsTree, string reason) =>
        $"Could not validate this plugin's {(holdsTree ? "source tree" : "binary")} ({reason}). Still showing " +
        "what was last read from it.";

    // ADR-0003: the status answering the version is published once the plugins are validated, and a
    // reconcile that changed the status reads Reconciling until then. The message when validation
    // failed outright, which becomes status data.
    private string? ValidateHeld(CancellationToken token)
    {
        lock (_lock)
        {
            if (_disposed || _scope is null) return null;
        }
        try
        {
            ValidateIndex(token);
            return null;
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // Busy, not broken: validation is idempotent, and the next snapshot validates again.
            logger.LogWarning(ex, "Could not validate the index while another write held it; it is re-checked at the next snapshot");
            return null;
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            // The failure becomes status data (plugins.md, States, story 6), and the next snapshot
            // tries again.
            logger.LogError(ex, "Validating the index failed unexpectedly");
            return ex.Message;
        }
    }

    // A tree the keys cannot be read from is diagnosed on the plugin by the whole read, as a first
    // ingest would diagnose it.
    private void RefreshByKeysOrReadWhole(
        OpenScope scope, PluginAddress key, string modFolder, IReadOnlyList<string> formKeys)
    {
        try
        {
            scope.Projector.RefreshByKeys(key, modFolder, formKeys);
        }
        catch (Exception ex) when (ex is AmbiguousSourceUnitException or UnreadableSourceDocumentException)
        {
            ReindexHeldPlugin(key);
        }
    }

    // ADR-0013, read whole rather than per plugin.
    private IReadOnlyList<RegisteredPlugin> Active() => holder.Current.Active;

    // ADR-0007.
    private void ReindexHeldPlugin(PluginAddress key)
    {
        // Taken before anything reaches _lock. IndexWriteGate is a Lock, thread-affine, so nothing
        // under this scope may await: the thread that exits must be the one that entered.
        using var _ = WriteGate.Enter();

        var (metadata, scope) = RequireHeldPlugin(key);
        // ADR-0015: a whole plugin re-derived is one projection, so it is one advance
        // whichever branch below runs.
        using var projection = scope.Index.BeginProjection();

        // A tracked plugin's truth is its source tree, so it is re-derived from there and its binary
        // is never opened.

        // Asked here as a bare "is this tracked" question; the door below resolves the tree it reads
        // for itself, so neither trusts the other about a folder either could have lost in between.
        if (Projector.HoldsTree(metadata.Key, metadata.Path))
            IngestFromSourceTree(key);
        else
            ReindexOne(metadata, scope);
    }

    // The same Projector.Ingest the reconcile's tracked branch runs, so a re-ingest and a first
    // ingest produce the same rows by construction. A failed read is recorded and rethrown, never
    // degraded to the binary.
    private void IngestFromSourceTree(PluginAddress key)
    {
        // Outside _lock, always. It takes the gate for itself rather than trusting its caller; the
        // reentrant gate makes that free.
        using var _ = WriteGate.Enter();

        var (metadata, scope) = RequireHeldPlugin(key);
        var index = scope.Index;
        using var projection = index.BeginProjection();
        if (!Projector.HoldsTree(metadata.Key, metadata.Path))
        {
            throw new InvalidOperationException(
                $"Plugin '{key.Name}' from '{key.Origin}' has no source tree to re-ingest; it is not tracked.");
        }

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Re-ingesting {Plugin} from its source tree", metadata.Name);
        }

        // Under _lock, unlike the reconcile's own ingest: this fires against a live index that every
        // other mutation door is serialized against by this same lock.
        lock (_lock)
        {
            try
            {
                scope.Projector.Ingest(metadata, ModFolderHoldingTree(metadata));
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Could not re-ingest {Plugin} from its source tree", metadata.Name);
                FailRead(scope, key, metadata.Path,
                    $"Could not re-read this plugin's source tree ({PluginLoadFailure.ReasonFor(ex)}). Still " +
                    "showing what was last read from it — the compiled binary is not used for a tracked plugin.");
                throw;
            }

            index.UpdateWinners(Active());
            filter.Reapply(index);
        }
        scope.Failed.Forget(key);
        if (scope.Held.ClearFailure(key)) PublishStatus();
        AnnouncePluginChanged(index, key);
    }

    private (PluginMetadata Metadata, OpenScope Scope) RequireHeldPlugin(PluginAddress key)
    {
        lock (_lock)
        {
            var scope = RequireScope();
            var metadata = scope.Held.Find(key)
                ?? throw new KeyNotFoundException($"Plugin '{key.Name}' from '{key.Origin}' is not held.");
            return (metadata, scope);
        }
    }

    // A failed read is recorded with the bytes it failed on and rethrown, so those bytes are not
    // read again until they change.
    private void ReindexOne(PluginMetadata metadata, OpenScope scope)
    {
        var index = scope.Index;
        try
        {
            using var documents = OpenDocuments(scope, metadata);
            lock (_lock)
            {
                index.Index(documents, metadata, metadata.Path, DerivedFrom.Binary);
                index.UpdateWinners(Active());
                filter.Reapply(index);
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            FailRead(scope, metadata.Key, metadata.Path, PluginLoadFailure.ReasonFor(ex));
            throw;
        }
        scope.Failed.Forget(metadata.Key);
        if (scope.Held.ClearFailure(metadata.Key)) PublishStatus();
        AnnouncePluginChanged(index, metadata.Key);
    }

    // The file is gone, so its rows go with it. A no-op while the held plugin still exists or with no
    // load order.
    private void UnindexGonePlugin(PluginAddress key)
    {
        // Gated like its sibling above. Outside _lock, never inside it.
        using var _ = WriteGate.Enter();

        DuckDbRecordIndex index;
        lock (_lock)
        {
            if (_scope is not { } scope) return;
            if (scope.Held.Find(key) is { } plugin && File.Exists(plugin.Path)) return;
            index = scope.Index;

            // Removing a plugin is one projection: its rows and the winners they moved.
            using var projection = index.BeginProjection();

            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "{Plugin} ({Origin}) is gone from disk; removing it from the index", key.Name, key.Origin);
            }
            index.Unindex(key);
            // A removal moves winners for every FormKey it held, exactly as a re-index does.
            index.UpdateWinners(Active());
            filter.Reapply(index);
        }
        AnnouncePluginChanged(index, key);
    }

    /// <summary>Drops the scope: the plugins it has open and the store's connection. Cancels an in-flight
    /// reconcile and waits for it to stop first; the load order is its own and is untouched.</summary>
    public void Close()
    {
        // Cancels an in-flight reconcile and waits for it to stop *before* disposing anything,
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
        _scope?.Index.Dispose();
        _scope = null;
        _indexed.Clear();
        _conflictsComputed = false;
        _validating = false;
        _plannedCount = 0;
        _activeCount = 0;
        _heldElsewhereMessage = null;
        _failureMessage = null;
    }
}
