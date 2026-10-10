using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index;

/// <summary>Brings the Store to the load order (ADR-0013), then validates every plugin against its
/// system of record (ADR-0003). It holds the plugins open, the progress Status reports, the scope
/// the Store is opened for, and the filter in force.</summary>
internal sealed class Indexer : IDisposable
{
    private readonly LoadOrderHolder _holder;
    private readonly UnsavedDocuments _unsaved;
    private readonly IPluginAdapter _adapter;
    private readonly ISourceAdapter _source;
    private readonly StoreFactory _storeFactory;
    private readonly FilterInForce _filter;
    // One per Indexer, never replaced: a reconcile swaps the store beneath it, which is when the
    // ordering matters most.
    private readonly IndexWriteGate _gate = new();
    private readonly ILogger _logger;
    private readonly INotificationPublisher? _notifications;
    private readonly TimeProvider _timeProvider;

    /// <summary>The registration's door: the Index opens its own store (ADR-0014).</summary>
    public Indexer(
        LoadOrderHolder holder,
        UnsavedDocuments unsaved,
        IPluginAdapter adapter,
        ISourceAdapter source,
        SchemaReflector schemaReflector,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null)
    {
        _holder = holder;
        _unsaved = unsaved;
        _adapter = adapter;
        _source = source;
        _notifications = notifications;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _logger = loggerFactory?.CreateLogger<Indexer>() ?? NullLogger<Indexer>.Instance;
        _filter = new FilterInForce(_logger, notifications);
        _storeFactory = new StoreFactory(
            schemaReflector, new TableDdlBuilder(schemaReflector), adapter, _gate, _filter, notifications,
            loggerFactory?.CreateLogger<StoreFactory>(), timeProvider);
    }

    // Lock order: _lock, then the Store's projection lock, which a projection's announcements run
    // under. An announcement reads the index's own Sequence, never this class's Sequence, Status or
    // RequireReads, which take _lock.
    private readonly Lock _lock = new();
    private OpenScope? _scope;

    // The reconcile's own progress. Guarded by _lock like _scope: written by the reconciling thread
    // as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<PluginAddress> _indexed = [];
    private bool _conflictsComputed;
    private bool _validating;
    private int _plannedCount;
    private int _activeCount;
    private IReadOnlyList<PluginLoadFailure> _collisionFailures = [];
    // Cleared at the top of every attempt: a repeated refusal re-sets it a moment later, a successful
    // one leaves it clear.
    private string? _heldElsewhereMessage;
    // The same lifetime as _heldElsewhereMessage, for the reconcile's other known-unknown outcome.
    private string? _failureMessage;
    private string? _handOverFailure;
    // The version the reconcile door last finished answering for: never a superseded attempt's,
    // since that one returns before reaching its own update.
    private long _version;
    // A detached index whose reads outlived the drain: it stays open, so a retry drains it again
    // before any store is opened on its path.
    private OpenScope? _undrained;

    // Two mechanisms, because one is not enough: the token asks the reconcile loop to stop, the
    // exclusive lock waits until it has. Cancelling without draining would let a teardown dispose
    // the DuckDB connection mid-write, a native crash.

    // Deliberately not _lock: the reconciling thread takes _lock on every plugin, so a waiter
    // holding it could never be signalled.
    private readonly Lock _exclusive = new();
    private CancellationTokenSource? _reconcileCancellation;
    private bool _disposed;

    private readonly List<string> _handed = [];
    private bool _validatingHanded;

    private sealed record OpenScope(HeldPlugins Held, Store Store, Projector Projector, FailedReads Failed);

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
    public IRecordReads RequireReads() => RequireScope().Store.Reads;

    public IRecordReads RequireWholeSetReads()
    {
        var status = Status;
        if (status.State == LoadOrderState.Ready) return RequireReads();
        if (_holder.Held is null) throw new NoLoadOrderException();
        throw new IndexNotReadyException(
            status.Message is { } reason ? $"mEdit's index is not ready: {reason}" : "mEdit's index is not ready.");
    }

    public IReadOnlyList<SourceFileFailure> SourceFileFailures
    {
        get { lock (_lock) return _scope?.Failed.SourceFileFailures ?? []; }
    }

    public UnreadableSource? WhyTreeStopped(PluginAddress key)
    {
        lock (_lock) return _scope?.Failed.WhyTreeStopped(key);
    }

    public IReadOnlyList<SourceFileFailure>? LaterReadFailure(PluginAddress key)
    {
        lock (_lock) return _scope?.Failed.LaterReadFailure(key);
    }

    private OpenScope RequireScope()
    {
        lock (_lock) return _scope ?? throw new NoLoadOrderException();
    }

    // Runs the action under the lock that disposing the scope takes, so the index cannot be closed
    // beneath it. False, having run nothing, with no scope held.
    private bool UnderScope<T>(Func<Store, IndexScope, T> action, [MaybeNullWhen(false)] out T result)
    {
        lock (_lock)
        {
            if (_scope is not { } scope)
            {
                result = default;
                return false;
            }
            result = action(scope.Store, IndexScope.Of(scope.Held));
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
                    held = new LoadOrderStatus(state, _plannedCount, _activeCount, [.. _indexed], _conflictsComputed, [.. _scope.Held.Failures, .. _collisionFailures], Version: _version);
                }

                if (_heldElsewhereMessage is { } heldElsewhere)
                    return held with { State = LoadOrderState.HeldElsewhere, Message = heldElsewhere };
                if ((_failureMessage ?? _handOverFailure) is { } failure)
                    return held with { State = LoadOrderState.Failed, Message = failure };
                return held;
            }
        }
    }

    // ADR-0015: every site that changes what Status reports calls this after. _lock is reentrant,
    // so this is safe to call from inside a lock a caller already holds.
    private void PublishStatus() => _notifications?.Publish(new LoadOrderStatusNotification(Status));

    public long Sequence { get { lock (_lock) return _scope?.Store.Sequence ?? 0; } }

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

    // ADR-0013: every arrival, changed or not, reconciles the snapshot held when it runs, so an
    // overtaken arrival reconciles the newer.
    private void StartReconcile() =>
        Task.Factory.StartNew(ReconcileHeld, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    // ADR-0015: a handed path is validated as a change on disk is. A reconcile in flight is waited out,
    // never cancelled; paths handed meanwhile are validated together.
    private void ValidateTreesHolding(IReadOnlyList<string> paths)
    {
        lock (_lock)
        {
            _handed.AddRange(paths);
            if (_validatingHanded) return;
            _validatingHanded = true;
        }
        Task.Factory.StartNew(ValidateHanded, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    private void ValidateHanded()
    {
        while (true)
        {
            List<string> paths;
            lock (_lock)
            {
                if (_handed.Count == 0 || _disposed)
                {
                    _validatingHanded = false;
                    return;
                }
                paths = [.. _handed];
                _handed.Clear();
            }

            bool moved;
            _exclusive.Enter();
            try
            {
                var failure = ValidationFailure(() => ValidateTreesOf(paths));
                lock (_lock)
                {
                    moved = _handOverFailure != failure;
                    _handOverFailure = failure;
                }
            }
            finally { _exclusive.Exit(); }
            if (moved) PublishStatus();
        }
    }

    private void ValidateTreesOf(List<string> paths)
    {
        var scope = RequireScope();
        var holding = scope.Held.Plugins.Where(plugin => paths.Exists(path => _source.TreeHolds(plugin.Registered, path))).ToList();
        if (holding.Count > 0) scope.Store.Commit(_ => holding.ForEach(plugin => ValidateOne(scope, plugin)));
    }

    // Disposal is read with the exclusive right held, which Dispose takes after setting it, so no
    // reconcile opens a store after Dispose.
    private void ReconcileHeld() => Reconcile(() =>
    {
        lock (_lock) return _disposed ? null : _holder.Held;
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
                refusalCleared = _heldElsewhereMessage is not null || _failureMessage is not null || _handOverFailure is not null;
                _heldElsewhereMessage = null;
                _failureMessage = null;
                _handOverFailure = null;
            }
            var token = BeginReconcile();
            if (EnsureScope(snapshot, out heldElsewhere, out failure) is not { } scope)
            {
                // Refused, or failed with a reason: nothing is held here (EnsureScope tore the
                // previous scope down before the open that refused).
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
            _logger.LogInformation(ex, "Load order reconcile was superseded before it completed");
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
    private OpenScope? EnsureScope(LoadOrderSnapshot snapshot, out string? heldElsewhere, out string? failure)
    {
        (heldElsewhere, failure) = (null, null);
        OpenScope? leaving;
        lock (_lock)
        {
            if (_scope is { } current && IndexScope.Of(current.Held).Matches(snapshot)) return current;
            leaving = DetachCurrent() ?? _undrained;
            _undrained = null;
            _filter.DropWhenOutside(snapshot);
        }
        if (leaving is not null)
        {
            if (SharesFile(leaving, snapshot) && !leaving.Store.EndReads())
            {
                lock (_lock) _undrained = leaving;
                failure = IndexWriteGate.NotDrained("mEdit's index was not reopened", "It is retried with the next load order.");
                return null;
            }
            leaving.Store.Dispose();
        }

        _logger.LogDebug("Initializing DuckDB record index");
        var createTimer = Stopwatch.StartNew();
        var held = new HeldPlugins(
            _adapter, snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.GameRelease, _logger);
        Store? fresh = null;
        OpenScope scope;
        try
        {
            fresh = _storeFactory.Create(
                snapshot.GameRelease, snapshot.InstanceRoot, () => held.OpenedPlugins,
                () => Status.State == LoadOrderState.Ready, out heldElsewhere);
            if (fresh is null) return null;
            scope = new OpenScope(held, fresh, new Projector(fresh, held.Find, _source, _logger), new FailedReads(fresh, _source, _logger));
            fresh = null;
        }
        finally
        {
            fresh?.Dispose();
        }
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("DuckDB record index initialized in {ElapsedMs} ms", createTimer.ElapsedMilliseconds);
        }

        lock (_lock)
        {
            _indexed.Clear();
            _conflictsComputed = false;
            _plannedCount = 0;
            _activeCount = 0;
            _collisionFailures = [];
            _scope = scope;
            _filter.Reapply(scope.Store);
        }
        PublishStatus();
        return scope;
    }

    // A different file has its own DuckDB instance, so a stuck read on the old one cannot reach the new.
    private static bool SharesFile(OpenScope leaving, LoadOrderSnapshot snapshot) =>
        leaving.Held.InstanceRoot is { } from && snapshot.InstanceRoot is { } to
        && string.Equals(IndexFile.For(from), IndexFile.For(to), StringComparison.OrdinalIgnoreCase);

    // The diff is computed first and without side effects (one stamp read and a folder probe per
    // plugin), so a snapshot that moves nothing writes nothing and publishes no status.

    // Registrations the snapshot has stopped naming are dropped before anything new is opened, so a
    // freshly opened index file's last-run rows stop answering as early as possible. False when the
    // snapshot moved nothing.
    private bool ReconcileProgressively(OpenScope scope, LoadOrderSnapshot snapshot, CancellationToken token)
    {
        var (held, store) = (scope.Held, scope.Store);
        FailCollisions(snapshot.CaseOnlyCollisions);
        var resolved = snapshot.Plugins;
        // A hash is kept only for a file the load order names, or the kept hashes grow by every path
        // a session ever read.
        _adapter.KeepHashesOf(resolved.Select(r => r.Path).ToHashSet(StringComparer.Ordinal));
        var wanted = resolved.ToDictionary(r => r.Key, PluginAddress.Comparer);
        var open = held.Plugins.ToDictionary(p => p.Key, PluginAddress.Comparer);

        // Registered, held, or held only as a failure row: a plugin the snapshot has stopped naming
        // leaves by every one of those doors, so a stale error row cannot outlive its plugin.
        var leaving = store.RegisteredPlugins()
            .Concat(held.Plugins.Select(p => p.Key))
            .Concat(scope.Failed.Keys)
            .Where(k => !wanted.ContainsKey(k))
            .Distinct(PluginAddress.Comparer)
            .ToList();
        var moved = resolved
            .Select(r => r.Key)
            .Where(key => open.TryGetValue(key, out var h) && (h.Key != key || h.Path != wanted[key].Path || h.Registration != Registration.In(snapshot, key)))
            .ToList();
        var respelled = resolved.Select(r => r.Key).Where(key => held.IsSpelledOtherwise(key)).ToList();
        // A plugin in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !open.ContainsKey(r.Key) && !scope.Failed.StillFailing(r)).ToList();
        // ADR-0007: which truth a plugin reads is its folder's answer, and the stamp
        // records the one its rows came from. Tracking and untracking move the first alone, and no
        // load-order difference above names them.
        var derivations = store.Reads.GetDerivations();
        var reDerived = resolved.Where(r => open.ContainsKey(r.Key) && TruthMoved(scope, r, derivations)).ToList();

        bool conflictsComputed;
        lock (_lock) conflictsComputed = _conflictsComputed;
        if (leaving.Count == 0 && moved.Count == 0 && respelled.Count == 0 && arriving.Count == 0 && reDerived.Count == 0 && conflictsComputed)
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
        // Reconciling begins here, with the total known: the first status a subscriber sees for
        // this reconcile.
        PublishStatus();

        if (leaving.Count > 0) store.Commit(_ => leaving.ForEach(store.Unregister));
        foreach (var key in leaving)
        {
            held.Remove(key);
            lock (_lock) _indexed.RemoveAll(i => PluginAddress.Comparer.Equals(new PluginAddress(i.Name, i.Origin), key));
            scope.Failed.Forget(key);
        }
        if (leaving.Count > 0) PublishStatus();

        // ADR-0012.
        if (moved.Count > 0) store.Commit(_ => moved.ForEach(key => store.Register(held.Update(open[key], wanted[key], Registration.In(snapshot, key)))));
        if (respelled.Count > 0)
        {
            foreach (var key in respelled)
            {
                held.RespellFailure(key);
            }
            lock (_lock)
            {
                foreach (var key in respelled)
                {
                    var at = _indexed.FindIndex(i => PluginAddress.Comparer.Equals(i, key));
                    if (at >= 0) _indexed[at] = key;
                }
            }
            PublishStatus();
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

            PluginMetadata? metadata = null;
            ReadOne(scope, plugin, state =>
                held.Open(plugin, Registration.In(snapshot, plugin.Key)).Holds(out metadata, out var failure)
                    ? RegisterOrIndex(scope, metadata, state, token)
                    : ReadOutcome.Failed(failure));
            if (metadata is null) continue;
            firstUsableMs ??= timer.ElapsedMilliseconds;
        }

        // The whole-set sweep, and the moment conflict information becomes correct: a plugin that
        // arrived earlier was browsable but its winner state was not yet decided (ADR-0013).
        _logger.LogDebug("Computing winners");
        var winnersTimer = Stopwatch.StartNew();
        store.Commit(_ => store.UpdateWinners(snapshot.Active));
        // Ready itself publishes from the reconcile door, once this version is stamped in.
        lock (_lock) _conflictsComputed = true;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Load order reconciled in {TotalMs} ms: {Arrived} arrived, {Moved} moved, {Left} left, {Held} held (first plugin usable after {FirstUsableMs} ms, winner sweep {WinnersMs} ms)",
                timer.ElapsedMilliseconds, arriving.Count, moved.Count, leaving.Count, held.Plugins.Count,
                firstUsableMs, winnersTimer.ElapsedMilliseconds);
        }
        return true;
    }

    // A plugin whose last read failed is the validation's to read again, once what it reads from changes.
    // A plugin with no rows has no truth to move from.
    private static bool TruthMoved(OpenScope scope, RegisteredPlugin plugin, IReadOnlyDictionary<PluginAddress, DerivedFrom> derivations) =>
        derivations.TryGetValue(plugin.Key, out var derivedFrom) && derivedFrom != scope.Projector.TruthOf(plugin)
        && !scope.Failed.Holds(plugin.Key);

    // A plugin whose folder gained or lost its repository or its tree since it was indexed. Nothing here
    // has compared the two truths, so the plugin is re-derived whole from the one its folder now offers.
    private void ReDeriveMovedTruths(OpenScope scope, IReadOnlyList<RegisteredPlugin> plugins, CancellationToken token)
    {
        foreach (var plugin in plugins)
        {
            token.ThrowIfCancellationRequested();
            if (scope.Held.Find(plugin.Key) is not { } metadata) continue;

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "{Plugin} ({Origin}) now reads as {Truth}; re-deriving it", plugin.Name, plugin.Origin,
                    scope.Projector.TruthOf(plugin));
            }
            ReadOne(scope, plugin, state => IndexOnePlugin(scope, metadata, state, token));
        }
    }

    // plugins.md, A row, Plugin: one plugin that cannot be read is that row's "Failed to read", never
    // the whole index's failure.
    private void ReadOne(OpenScope scope, RegisteredPlugin plugin, Func<ReadState, ReadOutcome> read)
    {
        try
        {
            if (scope.Failed.Read(plugin, read).Failure is { } failure)
                FailRead(scope, plugin.Key, ReadFailure(failure.Reason, scope.Store.DerivationOf(plugin.Key)));
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            _logger.LogWarning(ex, "Could not read {Plugin} ({Origin})", plugin.Name, plugin.Origin);
            FailRead(scope, plugin.Key, ReadFailure(PluginLoadFailure.ReasonFor(ex), scope.Store.DerivationOf(plugin.Key)));
        }
    }

    // plugins.md, A row, Plugin: each plugin of a case-only collision is that row's "Failed to read".
    private void FailCollisions(IReadOnlyList<RegisteredPlugin> collided)
    {
        IReadOnlyList<PluginLoadFailure> failures =
        [
            .. collided.GroupBy(p => p.Key, PluginAddress.Comparer).SelectMany(twins => twins.Select(plugin =>
            {
                var others = twins.Where(other => other != plugin).ToList();
                var differing = (others.Any(o => o.Name != plugin.Name), others.Any(o => o.Origin != plugin.Origin)) switch
                {
                    (true, true) => "name and origin",
                    (true, false) => "name",
                    _ => "origin",
                };
                return new PluginLoadFailure(plugin.Name, plugin.Origin,
                    $"Its {differing} differs only in case from {string.Join(", ", others.Select(o => $"{o.Name} from {o.Origin}"))}, "
                    + "so no one can tell which the game loads. None is read.");
            })),
        ];
        lock (_lock)
        {
            if (failures.SequenceEqual(_collisionFailures)) return;
            _collisionFailures = failures;
        }
        foreach (var failure in failures)
            _logger.LogWarning("Could not read {Plugin} ({Origin}): {Reason}", failure.Name, failure.Origin, failure.Reason);
    }

    // common.md, Errors (ADR-0019): the rows a failed read leaves stand, and the reason says whose they are.
    private static string ReadFailure(string reason, DerivedFrom? rowsFrom) =>
        $"Could not read this plugin ({reason})." + rowsFrom switch
        {
            null => "",
            DerivedFrom.SourceTree => " Still showing what was last read from its source tree.",
            _ => " Still showing what was last read from its compiled binary.",
        };

    // Registers first: the index's reads are scoped by registration, so validate would otherwise
    // compare an empty row set against a full tree. False falls through to a full index.
    private bool WarmRegister(OpenScope scope, PluginMetadata plugin, ReadState state)
    {
        scope.Store.Register(plugin);

        // A binary was already hashed against its stored claim when the index file opened
        // (Store.ValidateAgainstDisk), so a second hash of every binary here would pay that whole cost
        // twice for no new answer.
        var truth = scope.Projector.TruthOf(plugin.Registered);
        if (truth != DerivedFrom.SourceTree) return scope.Store.DerivationOf(plugin.Key) == truth;

        try
        {
            var report = scope.Projector.Validate(plugin.Registered, state);
            foreach (var failure in report.Failures)
                _logger.LogWarning("Validating {Plugin} at load: {Failure}", plugin.Name, failure);
            return !report.NeedsRebuild;
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            // A validation that failed is no evidence the rows are still true: the whole read below
            // re-derives them and reports its own failure.
            _logger.LogWarning(ex, "Validating {Plugin} ({Origin}) at load failed; reading it whole", plugin.Name, plugin.Origin);
            return false;
        }
    }

    // A failure that says what the plugin already said publishes nothing.
    private void FailRead(OpenScope scope, PluginAddress key, string reason)
    {
        if (scope.Held.SetFailure(key, reason)) PublishStatus();
    }

    // Listed only once its commit has landed: Status promises a plugin listed here is wholly
    // queryable, the filter's matches in it included, and a registered one is.
    private ReadOutcome RegisterOrIndex(OpenScope scope, PluginMetadata plugin, ReadState state, CancellationToken token)
    {
        var outcome = scope.Store.Commit(_ => RegisterWarmOrIndex(scope, plugin, state, token));
        if (outcome.Failure is not null) return outcome;
        lock (_lock) _indexed.Add(plugin.Key);
        PublishStatus();
        return outcome;
    }

    // ADR-0010: a plugin the store has seen, still matching the disk, is registered, not
    // indexed; ADR-0015 validates a tracked plugin by content on that same warm path.
    private ReadOutcome RegisterWarmOrIndex(OpenScope scope, PluginMetadata plugin, ReadState state, CancellationToken token)
    {
        if (scope.Store.IndexedContentHash(plugin.Key) != null && WarmRegister(scope, plugin, state))
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Registering {Plugin} ({RecordCount} records), already indexed and unchanged on disk",
                    plugin.Name, plugin.RecordCount);
            }
            return ReadOutcome.Read;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Indexing {Plugin} ({RecordCount} records)", plugin.Name, plugin.RecordCount);
        }
        var indexTimer = Stopwatch.StartNew();
        var outcome = IndexOnePlugin(scope, plugin, state, token);
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Indexed {Plugin} in {ElapsedMs} ms", plugin.Name, indexTimer.ElapsedMilliseconds);
        }
        return outcome;
    }

    // ADR-0007; HeldPlugins still reads a tracked plugin's metadata off its binary.

    // One commit for the whole plugin, whichever door it came through (ADR-0015).
    private ReadOutcome IndexOnePlugin(OpenScope scope, PluginMetadata plugin, ReadState state, CancellationToken token) =>
        scope.Store.Commit(_ => IndexOnePluginRows(scope, plugin, state, token));

    // plugins.md, A row, Plugin: a tree that fails to read leaves the binary's rows, marked as standing
    // in for it, and answers what stopped it. Only the binary's own failure throws.
    private ReadOutcome IndexOnePluginRows(OpenScope scope, PluginMetadata plugin, ReadState state, CancellationToken token)
    {
        var truth = scope.Projector.TruthOf(plugin.Registered);
        if (truth != DerivedFrom.SourceTree) return IndexFromBinary(scope, plugin, truth);

        ReadOutcome stoppedAt;
        try
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Ingesting {Plugin} from its source tree", plugin.Name);
            }
            if (scope.Projector.Ingest(plugin, token) is not { } stopped) return ReadOutcome.Read;
            _logger.LogWarning("Could not ingest {Plugin} from its source tree; reading its binary: {Reason}", plugin.Name, stopped.Reason);
            stoppedAt = ReadOutcome.StoppedAt(stopped);
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            // Every exception, not a curated set: a third-party deserializer fails in open-ended ways.
            _logger.LogWarning(ex, "Could not ingest {Plugin} from its source tree; reading its binary", plugin.Name);
            stoppedAt = ReadOutcome.StoppedAt(ex);
        }

        var binary = BinaryStandsIn(scope.Store, plugin.Key, state)
            ? ReadOutcome.Read
            : IndexFromBinary(scope, plugin, DerivedFrom.BinaryForUnreadableSource);
        return binary.Failure is null ? stoppedAt : binary;
    }

    // A tree that fails at every snapshot reads its binary once per change of its bytes.
    private static bool BinaryStandsIn(Store store, PluginAddress key, ReadState state) =>
        store.DerivationOf(key) == DerivedFrom.BinaryForUnreadableSource
        && state.Binary is { } binary && store.IndexedContentHash(key) == binary;

    // ADR-0005: the binary reaches the index as documents, through the adapter's own door,
    // never as a mod this side holds.
    private ReadOutcome IndexFromBinary(OpenScope scope, PluginMetadata plugin, DerivedFrom derivedFrom)
    {
        if (!_adapter.OpenDocuments(
                new ModPath(ModKey.FromFileName(Path.GetFileName(plugin.Path)), plugin.Path),
                scope.Store.Release,
                scope.Store.Schemas,
                new PluginStrings(Path.GetDirectoryName(plugin.Path), scope.Held.DataFolderPath))
            .Holds(out var opened, out var failure))
        {
            _logger.LogWarning(failure.Error, "Could not read {Plugin} ({Origin}): {Reason}", plugin.Name, plugin.Origin, failure.Reason);
            return ReadOutcome.Failed(failure);
        }

        using var documents = opened;
        scope.Store.Index(documents, plugin, plugin.Path, derivedFrom);
        return ReadOutcome.Read;
    }

    // ADR-0015.
    private void ValidateIndex(CancellationToken token)
    {
        var scope = RequireScope();
        // A plugin not held failed to open, and the reconcile opens it again once its bytes change.
        scope.Store.Commit(_ =>
        {
            foreach (var metadata in scope.Held.Plugins)
            {
                token.ThrowIfCancellationRequested();
                ValidateOne(scope, metadata);
            }
        });
    }

    // plugins.md, A row, Plugin, "Failed to read": a plugin that cannot be read is flagged, and the
    // rest are still validated. A failed one is read whole again once what it reads from changed.
    private void ValidateOne(OpenScope scope, PluginMetadata plugin)
    {
        var (held, store) = (scope.Held, scope.Store);
        var key = plugin.Key;
        var holdsTree = scope.Projector.TruthOf(plugin.Registered) == DerivedFrom.SourceTree;
        try
        {
            if (!holdsTree && !_adapter.Exists(plugin.Path))
            {
                if (store.IndexedContentHash(key) is not null) store.Unindex(key);
                return;
            }

            // Rows a failed read left say nothing of what the plugin now reads from.
            if (held.IsHeldWithAFailure(key) || scope.Failed.Holds(key))
            {
                if (!scope.Failed.StillFailing(plugin.Registered)) ReindexHeldPlugin(scope, plugin);
                return;
            }

            var readWhole = false;
            scope.Failed.Read(plugin.Registered, state =>
            {
                readWhole = MustReadWhole(scope, plugin, holdsTree, state);
                return ReadOutcome.Read;
            });
            if (readWhole) ReindexHeldPlugin(scope, plugin);
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            _logger.LogWarning(ex, "Could not validate {Plugin} ({Origin})", key.Name, key.Origin);
            // A re-read that failed has named its own failure.
            if (!held.IsHeldWithAFailure(key)) FailRead(scope, key, ValidationFailure(holdsTree, PluginLoadFailure.ReasonFor(ex)));
        }
    }

    // When the rows cannot be brought true here. A tree that cannot be read is read whole, which reads
    // the binary in its place and names what stopped it.
    private bool MustReadWhole(OpenScope scope, PluginMetadata plugin, bool holdsTree, ReadState state)
    {
        var key = plugin.Key;
        try
        {
            var report = scope.Projector.Validate(plugin.Registered, state);
            foreach (var failure in report.Failures)
                _logger.LogWarning("Reconciling {Plugin}: {Failure}", key.Name, failure);

            // Gained records are refreshed by key so the rows that moved are named (ADR-0015).
            if (report.NeedsRebuild && report.ChangedKeys.Count > 0 && plugin.Provider is PluginProvider.FromMod)
            {
                if (scope.Projector.RefreshByKeys(plugin.Registered, report.ChangedKeys) is not { } stopped) return false;
                _logger.LogWarning("Reconciling {Plugin}: {Failure}; reading it whole", key.Name, stopped.Reason);
                return true;
            }
            // An untracked plugin's rows went with its file, and the file is back.
            return report.NeedsRebuild || (!holdsTree && scope.Store.IndexedContentHash(key) is null);
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            _logger.LogWarning(ex, "Reconciling {Plugin}: its rows cannot be validated, so it is read whole", key.Name);
            return true;
        }
    }

    // editor.md, States, story 6: the rows stay the last good read, and say why.
    private static string ValidationFailure(bool holdsTree, string reason) =>
        $"Could not validate this plugin's {(holdsTree ? "source tree" : "binary")} ({reason}). Still showing " +
        "what was last read from it.";

    // ADR-0003: the status answering the version is published once the plugins are validated, and a
    // reconcile that changed the status reads Reconciling until then. The message when validation
    // failed outright, which becomes status data.
    private string? ValidateHeld(CancellationToken token) => ValidationFailure(() => ValidateIndex(token));

    private string? ValidationFailure(Action validate)
    {
        lock (_lock)
        {
            if (_disposed || _scope is null) return null;
        }
        try
        {
            validate();
            return null;
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // Busy, not broken: validation is idempotent, and the next snapshot validates again.
            _logger.LogWarning(ex, "Could not validate the index while another write held it; it is re-checked at the next snapshot");
            return null;
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            // The failure becomes status data (plugins.md, States, story 6), and the next snapshot
            // tries again.
            _logger.LogError(ex, "Validating the index failed unexpectedly");
            return ex.Message;
        }
    }

    // ADR-0007: the read a first index runs, so a re-read produces the same rows by construction. A
    // failed read is recorded with what it read from and rethrown, so it is not read again until that
    // changes.
    private void ReindexHeldPlugin(OpenScope scope, PluginMetadata plugin)
    {
        var key = plugin.Key;
        ReadOutcome outcome;
        try
        {
            outcome = scope.Store.Commit(projection =>
            {
                var read = scope.Failed.Read(plugin.Registered, state => IndexOnePlugin(scope, plugin, state, CancellationToken.None));
                if (read.Failure is null) projection.PluginChanged(key);
                return read;
            });
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            FailRead(scope, key, ReadFailure(PluginLoadFailure.ReasonFor(ex), scope.Store.DerivationOf(key)));
            throw;
        }
        if (outcome.Failure is { } failure) FailRead(scope, key, ReadFailure(failure.Reason, scope.Store.DerivationOf(key)));
        else if (scope.Held.ClearFailure(key)) PublishStatus();
    }

    /// <summary>The filter in force and the source its SQL came from, read together so a
    /// concurrent set never pairs one filter's SQL with another's source.</summary>
    public (string Sql, string Source)? ActiveFilter => _filter.Current;

    /// <summary>Answers why the SQL cannot be a filter, such as no form_key column. Throws
    /// <see cref="NoLoadOrderException"/> with no store to hold it.</summary>
    public string? SetFilter(string sql, string source) => ApplyFilter((sql, source));

    public void ClearFilter() => ApplyFilter(null);

    private string? ApplyFilter((string Sql, string Source)? filter)
    {
        // Materializing the filter is an index write, and the filter box is live while an edit runs, so
        // racing an in-flight edit is the ordinary case: gated like every write.
        using var _ = _gate.Enter();

        if (UnderScope((store, scope) => _filter.Set(store, scope, filter), out var rejection)) return rejection;

        // A filter kept through a rebuild outlives the store it was materialized in.
        if (filter is not null) throw new NoLoadOrderException();
        _filter.Clear();
        return null;
    }

    /// <summary>ADR-0010: drops the index file, floors its sequence at what this process
    /// handed out, and refills it off the caller's thread. A file another window holds, or a read
    /// that never ended, is refused.</summary>
    public StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        var previousSequence = Sequence;
        if (!Close())
        {
            StartReconcile();
            return new(StoreRebuildRefusal.StillServingReads,
                IndexWriteGate.NotDrained("mEdit's index was not rebuilt", "It is reopened as it was."));
        }
        if (_storeFactory.Rebuild(gameRelease, instanceRoot, previousSequence) is { } heldElsewhere)
            return new(StoreRebuildRefusal.HeldByAnotherWindow, heldElsewhere);
        StartReconcile();
        return null;
    }

    public void Subscribe()
    {
        _holder.Arrived += OnArrived;
        _unsaved.Arrived += ValidateTreesHolding;
    }

    private void OnArrived(LoadOrderSnapshot snapshot, long version) => StartReconcile();

    // False when a read outlived Store.EndReads: that index stays open, so nothing opens a store on
    // its file.
    private bool Close()
    {
        // Cancels an in-flight reconcile and waits for it to stop *before* disposing anything,
        // the teardown half of the cancellation. Disposing while the loop still holds the
        // index is a native crash, not a catchable one.
        EnterExclusive();
        bool readsEnded;
        try
        {
            OpenScope? closing;
            lock (_lock)
            {
                closing = DetachCurrent() ?? _undrained;
                _undrained = null;
            }
            readsEnded = closing?.Store.EndReads() ?? true;
            if (readsEnded) closing?.Store.Dispose();
            else lock (_lock) _undrained = closing;
        }
        finally { ExitExclusive(); }

        PublishStatus();
        return readsEnded;
    }

    public void Dispose()
    {
        _holder.Arrived -= OnArrived;
        _unsaved.Arrived -= ValidateTreesHolding;

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
            OpenScope? closing;
            lock (_lock)
            {
                closing = DetachCurrent();
                // EndReconcile already clears this on every reconcile's own exit path; this is the
                // exclusive-holder's own backstop, not the common case.
                _reconcileCancellation?.Dispose();
                _reconcileCancellation = null;
            }
            closing?.Store.Dispose();
            _undrained?.Store.Dispose();
        }
        finally { ExitExclusive(); }
    }

    // Disposing the scope waits out its reads, so its caller does that outside _lock, which every
    // Status and read takes.
    private OpenScope? DetachCurrent()
    {
        var detached = _scope;
        _scope = null;
        _indexed.Clear();
        _conflictsComputed = false;
        _validating = false;
        _plannedCount = 0;
        _activeCount = 0;
        _collisionFailures = [];
        _heldElsewhereMessage = null;
        _failureMessage = null;
        _handOverFailure = null;
        return detached;
    }
}
