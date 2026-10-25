using System.Diagnostics;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Store;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex;

/// <summary>Brings the Store to the load order (ADR-0013), then validates every plugin against its
/// system of record (ADR-0003). It holds the open plugins, the progress and the Store's scope.</summary>
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
    private Language _readLanguage = Language.English;

    /// <summary>The registration's door: the Index opens its own store (ADR-0014).</summary>
    public Indexer(
        LoadOrderHolder holder,
        UnsavedDocuments unsaved,
        IPluginAdapter adapter,
        ISourceAdapter source,
        SchemaReflector schemaReflector,
        FilterInForce filter,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null)
    {
        _holder = holder;
        _unsaved = unsaved;
        _adapter = adapter;
        _source = source;
        _filter = filter;
        _notifications = notifications;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _logger = loggerFactory?.CreateLogger<Indexer>() ?? NullLogger<Indexer>.Instance;
        _storeFactory = new StoreFactory(
            schemaReflector, new TableDdlBuilder(schemaReflector), adapter, source, _gate, _filter, notifications,
            loggerFactory?.CreateLogger<StoreFactory>(), timeProvider);
    }

    // Lock order: _lock, then the Store's projection lock, which a projection's announcements run
    // under. An announcement reads the record index's own Sequence, never this class's Sequence, Status or
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
    private sealed record Standing(long Version, string? HeldElsewhere, string? Failure, string? HandOverFailure)
    {
        public Standing WithoutRefusals() => this with { HeldElsewhere = null, Failure = null, HandOverFailure = null };
    }

    // Replaced whole under _lock, never edited in place, so a reader sees a version with its own refusals.
    private Standing _standing = new(0, null, null, null);

    private bool Swap(Func<Standing, Standing> change)
    {
        lock (_lock)
        {
            var next = change(_standing);
            if (next == _standing) return false;
            _standing = next;
            return true;
        }
    }

    private (long Version, LoadOrderState State, string? Message) _told;

    // ADR-0015: every site that changes what Status reports calls this after. A status counts as told
    // only once Publish returns. _lock is reentrant, so this is safe from inside a lock a caller holds.
    private void PublishStatus()
    {
        lock (_lock)
        {
            var status = Status;
            _notifications?.Publish(new LoadOrderStatusNotification(status));
            _told = (status.Version, status.State, status.Message);
        }
    }

    // A swap whose publish never came, such as a superseded attempt's, is told by the next attempt's close.
    private bool Untold()
    {
        lock (_lock)
        {
            var status = Status;
            return _told != (status.Version, status.State, status.Message);
        }
    }

    // Two mechanisms, because one is not enough: the token asks the reconcile loop to stop, the
    // exclusive lock waits until it has. Cancelling without draining would let a teardown dispose
    // the store connection mid-write, a native crash.

    // Deliberately not _lock: the reconciling thread takes _lock on every plugin, so a waiter
    // holding it could never be signalled.
    private readonly Lock _exclusive = new();
    // Only disposal stops a plugin read partway, inside the one transaction its rows land in. A newer
    // snapshot waits for the plugin in hand: snapshots come with every source write (ADR-0015), and each
    // reconcile must make progress.
    private readonly CancellationTokenSource _disposal = new();

    private bool _reconcileAsked;
    private readonly List<string> _handed = [];
    private bool _working;
    private bool _disposed;
    private CancellationTokenSource? _reconcileCancellation;

    // Guards the five fields above. Not _lock, so an arrival never waits on a status read or publish; none
    // of this class's other locks is taken inside it.
    private readonly Lock _turns = new();

    // The arrivals the last whole reconcile read the disk after, guarded by _lock and pulsed on _reconciled, which a
    // read after a source write waits on.
    private long _arrivalReconciled;
    private readonly object _reconciled = new();
    private static readonly TimeSpan SourceWriteReadLimit = TimeSpan.FromSeconds(60);

    // LoadOrder: the snapshot the scope last reconciled, which holds the masters a plugin is read against.
    private sealed record OpenScope(HeldPlugins Held, Store.Store Store, Projector Projector, FailedReads Failed, LoadOrderSnapshot LoadOrder);

    // Takes the exclusive right to tear down, waiting out the worker's turn and cancelling its reconcile.
    // Always paired with ExitExclusive in a finally.
    private void EnterExclusive()
    {
        lock (_turns) CancelInFlight();
        _exclusive.Enter();
    }

    // Cancel and dispose both happen under _turns, so a token can never be cancelled after it has
    // been disposed.
    private void CancelInFlight()
    {
        if (_reconcileCancellation is not { } inFlight) return;
        inFlight.Cancel();
        _logger.LogDebug("Asked the reconcile in flight to stop");
    }

    private void ExitExclusive() => _exclusive.Exit();

    // A read that ignores cancellation, as a Mutagen read can, would otherwise hold closing mEdit, and
    // the record index file with it, for ever.
    private static readonly TimeSpan CloseLimit = TimeSpan.FromSeconds(10);

    private bool EnterExclusiveWithin(TimeSpan limit)
    {
        lock (_turns) CancelInFlight();
        var deadline = _timeProvider.GetUtcNow() + limit;
        while (!_exclusive.TryEnter(SequencePollInterval))
        {
            if (_timeProvider.GetUtcNow() >= deadline) return false;
        }
        return true;
    }

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: before the first reconcile
    /// the Index has opened no store to read.</summary>
    public RelationReads RequireReads()
    {
        AwaitTheReconcileAfterTheLastSourceWrite();
        return RequireScope().Store.Reads;
    }

    public RelationReads RequireWholeSetReads()
    {
        AwaitTheReconcileAfterTheLastSourceWrite();
        var status = Status;
        if (status.State == LoadOrderState.Ready) return RequireReads();
        if (_holder.Held is null) throw new NoLoadOrderException();
        throw new IndexNotReadyException(
            status.Message is { } reason ? $"mEdit's record index is not ready: {reason}" : "mEdit's record index is not ready.");
    }

    public IReadOnlyList<SourceFileFailure> SourceFileFailures
    {
        get { lock (_lock) return _scope?.Failed.SourceFileFailures ?? []; }
    }

    public IReadOnlyList<(PluginAddress Plugin, FileProblem Problem)> FileProblems
    {
        get { lock (_lock) return _scope?.Failed.FileProblems ?? []; }
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
                    held = LoadOrderStatus.None with { Version = _standing.Version };
                }
                else
                {
                    var state = _conflictsComputed && !_validating ? LoadOrderState.Ready : LoadOrderState.Reconciling;
                    held = new LoadOrderStatus(state, _plannedCount, _activeCount, [.. _indexed], _conflictsComputed, [.. _scope.Held.Failures, .. _collisionFailures], Version: _standing.Version);
                }

                if (_standing.HeldElsewhere is { } heldElsewhere)
                    return held with { State = LoadOrderState.HeldElsewhere, Message = heldElsewhere };
                if ((_standing.Failure ?? _standing.HandOverFailure) is { } failure)
                    return held with { State = LoadOrderState.Failed, Message = failure };
                return held;
            }
        }
    }


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

    /// <summary>A read met the store's invalidation: reconciling reopens the store (ADR-0003).</summary>
    public void RecoverFromInvalidation() => AskReconcile();

    // ADR-0013: every arrival, changed or not, reconciles the snapshot held when its turn runs, so an
    // overtaken arrival reconciles the newer.
    private void AskReconcile()
    {
        lock (_turns)
        {
            _reconcileAsked = true;
            CancelInFlight();
            WakeWorker();
        }
    }

    // ADR-0015: a handed path is validated as a change on disk is. A reconcile in flight is waited out,
    // never cancelled.
    private void ValidateTreesHolding(IReadOnlyList<string> paths)
    {
        lock (_turns)
        {
            _handed.AddRange(paths);
            WakeWorker();
        }
    }

    private void WakeWorker()
    {
        if (_working || _disposed) return;
        _working = true;
        Task.Factory.StartNew(Work, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    private void Work()
    {
        while (NextTurn() is { } turn)
        {
            try { turn(); }
            catch (Exception ex) when (!CancelledBy(ex, CancellationToken.None))
            {
                _logger.LogError(ex, "Keeping the record index current failed unexpectedly");
                try { PublishStatus(); }
                catch (Exception publishFault) when (!CancelledBy(publishFault, CancellationToken.None))
                {
                    _logger.LogError(publishFault, "Publishing the status after a failed turn failed");
                }
            }
        }
    }

    private Action? NextTurn()
    {
        lock (_turns)
        {
            if (_disposed || (!_reconcileAsked && _handed.Count == 0))
            {
                _working = false;
                return null;
            }
            if (_reconcileAsked)
            {
                _reconcileAsked = false;
                return ReconcileHeld;
            }
            List<string> paths = [.. _handed];
            _handed.Clear();
            return () => ValidateAndPublish(paths);
        }
    }

    private void ValidateAndPublish(List<string> paths)
    {
        bool moved;
        _exclusive.Enter();
        try
        {
            var failure = ValidationFailure(() => ValidateTreesOf(paths), CancellationToken.None, out _);
            moved = Swap(standing => standing with { HandOverFailure = failure });
        }
        finally { _exclusive.Exit(); }
        if (moved) PublishStatus();
    }

    private void ValidateTreesOf(List<string> paths)
    {
        var scope = RequireScope();
        var holding = scope.Held.Plugins.Where(plugin => paths.Exists(path => _source.TreeHolds(plugin.Registered, path))).ToList();
        if (holding.Count > 0) Validate(scope, holding, CancellationToken.None);
    }

    // Disposal is read with the exclusive right held, which Dispose takes after setting it, so no
    // reconcile opens a store after Dispose.
    private void ReconcileHeld() => Reconcile(() =>
    {
        lock (_turns) return _disposed ? null : _holder.Held;
    });

    // ADR-0013's one verb, then every plugin validated (ADR-0003). The arrival is read once the
    // exclusive right is held, so a refill reconciles the load order held then. Null reconciles
    // nothing.
    private void Reconcile(Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival)
    {
        long arrivals = 0;
        bool arrived;
        bool refused;
        try
        {
            arrived = ReconcileOrRefuse(arrival, ref arrivals, out refused);
        }
        catch (OperationCanceledException ex)
        {
            // Superseded: the reconcile that cancelled this one answers for this version or
            // higher, so nothing here is ever the last word for it. Normal, not a failure:
            // Information, not Warning.
            _logger.LogInformation(ex, "Load order reconcile was superseded before it completed");
            return;
        }
        if (arrived)
        {
            if (!refused)
            {
                lock (_lock) _arrivalReconciled = Math.Max(_arrivalReconciled, arrivals);
            }
            lock (_reconciled) Monitor.PulseAll(_reconciled);
        }
    }

    // ADR-0015, read-your-writes: a source write reaches the record index through the next snapshot, so a read after one waits
    // for that snapshot's reconcile, and refuses rather than answer the rows from before it.
    private void AwaitTheReconcileAfterTheLastSourceWrite()
    {
        var awaited = _holder.ArrivalAwaited;
        var deadline = _timeProvider.GetUtcNow() + SourceWriteReadLimit;
        lock (_reconciled)
        {
            while (ArrivalReconciled < awaited)
            {
                var remaining = deadline - _timeProvider.GetUtcNow();
                if (remaining <= TimeSpan.Zero)
                {
                    throw new IndexNotReadyException(
                        "mEdit's record index has not read the plugin source mEdit wrote: no load order arrived after the write, " +
                        $"or its reconcile did not finish{(Status.Message is { } reason ? $" ({reason})" : "")}.");
                }
                Monitor.Wait(_reconciled, remaining < SequencePollInterval ? remaining : SequencePollInterval);
            }
        }
    }

    private long ArrivalReconciled
    {
        get { lock (_lock) return _arrivalReconciled; }
    }

    // A superseded reconcile throws, leaving its work to its successor. The closing swap and its publish
    // share one hold of _lock, so no reader sees a version before the status answering it.
    private bool ReconcileOrRefuse(
        Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival, ref long arrivals, out bool refused)
    {
        _exclusive.Enter();
        var token = CancellationToken.None;
        var superseded = false;
        var progressed = false;
        long version = 0;
        string? heldElsewhere = null;
        string? failure = null;
        refused = false;
        try
        {
            if (arrival() is not { } resolved) return false;
            var (snapshot, arrived) = resolved;
            version = arrived;
            arrivals = _holder.Arrivals;
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Reconciling load order. DataFolder={DataFolder} Instance={Instance} Plugins={Count} Game={Game}",
                    snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.Plugins.Count, snapshot.GameRelease);
            }

            // A fresh attempt starting: whatever the previous attempt's own refusal set is stale the
            // moment this one is asked for, whichever way this one goes.
            progressed = Swap(standing => standing.WithoutRefusals());
            token = BeginReconcile();
            if (EnsureScope(snapshot, out heldElsewhere, out failure) is not { } scope)
            {
                // Refused, or failed with a reason: nothing is held here (EnsureScope tore the
                // previous scope down before the open that refused).
                return true;
            }
            progressed |= ReconcileProgressively(scope, snapshot, token);
            failure = ValidateHeld(token, out var busy);
            // A validation the busy gate stopped has not read the disk whole.
            if (busy) arrivals = 0;
            return true;
        }
        catch (Exception ex) when (CancelledBy(ex, token))
        {
            superseded = true;
            throw;
        }
        catch (Exception ex) when (!CancelledBy(ex, token))
        {
            // Every type, out of memory included: nothing above observes a throw, so one left here
            // would leave the status Reconciling for ever (plugins.md, States, story 6).
            _logger.LogError(ex, "Load order reconcile failed");
            failure = FailureAfterReopening(ex);
            return true;
        }
        finally
        {
            EndReconcile();
            refused = heldElsewhere is not null || failure is not null;
            try
            {
                if (!superseded)
                {
                    lock (_lock)
                    {
                        _validating = false;
                        var swapped = Swap(standing => standing with
                        {
                            Version = Math.Max(standing.Version, version),
                            HeldElsewhere = heldElsewhere ?? standing.HeldElsewhere,
                            Failure = failure ?? standing.Failure,
                        });
                        if (swapped || progressed || Untold()) PublishStatus();
                    }
                }
            }
            finally { ExitExclusive(); }
        }
    }

    private bool CancelledBy(Exception ex, CancellationToken token) =>
        ex is OperationCanceledException && (token.IsCancellationRequested || _disposal.IsCancellationRequested);

    // ADR-0003: recovery is not gated. The plugins read before the fatal keep their rows, so the held
    // plugins and the indexed list stay. Runs with the exclusive right held.
    private string FailureAfterReopening(Exception cause)
    {
        if (cause is not IndexFaultException { Fault: IndexFault.Invalidated }) return cause.Message;
        try
        {
            return ReopenStore() is { } notReopened ? $"{cause.Message} {notReopened}" : cause.Message;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Reopening the record index failed");
            return $"{cause.Message} {NotReopened}: {ex.Message}";
        }
    }

    private const string NotReopened = "mEdit's record index was not reopened";

    private OpenScope ScopeOn(HeldPlugins held, Store.Store store, LoadOrderSnapshot snapshot) =>
        new(held, store, new Projector(store, held.Find, _source, _logger), new FailedReads(store, _source, _logger), snapshot);

    private string? ReopenStore()
    {
        OpenScope? current;
        lock (_lock)
        {
            current = _scope;
            _scope = null;
        }
        if (current is null) return null;
        if (!_storeFactory.Close(current.Store))
            return IndexWriteGate.NotDrained(NotReopened, "It is retried with the next load order.");

        var snapshot = current.LoadOrder;
        var held = current.Held;
        // Held to the swap, as EnsureScope holds it.
        using (_gate.Enter())
        {
            var fresh = _storeFactory.Create(
                snapshot.GameRelease, snapshot.InstanceRoot, () => held.OpenedPlugins,
                () => Status.State == LoadOrderState.Ready, out var heldElsewhere);
            if (fresh is null) return $"{NotReopened}: {heldElsewhere ?? "another process holds it"}";
            lock (_lock) _scope = ScopeOn(held, fresh, snapshot);
        }
        PublishStatus();
        return null;
    }

    private bool FailsOnePlugin(Exception ex, CancellationToken token) =>
        ex is not IndexFaultException { Fault: IndexFault.Invalidated } && !CancelledBy(ex, token);

    // A whole read after a validation that ran out of memory would run out again.
    private bool RetriedByAWholeRead(Exception ex, CancellationToken token) =>
        ex is not OutOfMemoryException && FailsOnePlugin(ex, token);

    // Called with the exclusive right held, so no other reconcile can be in flight.
    private CancellationToken BeginReconcile()
    {
        var cts = new CancellationTokenSource();
        lock (_turns) _reconcileCancellation = cts;
        return cts.Token;
    }

    private void EndReconcile()
    {
        lock (_turns)
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
            if (_scope is { } current && IndexScope.Of(current.Held).Matches(snapshot) && !current.Store.IsInvalidated())
            {
                _scope = current with { LoadOrder = snapshot };
                return _scope;
            }
            leaving = DetachCurrent();
            _filter.DropWhenOutside(snapshot);
        }
        if (!_storeFactory.Close(leaving?.Store, snapshot.InstanceRoot))
        {
            failure = IndexWriteGate.NotDrained(NotReopened, "It is retried with the next load order.");
            return null;
        }

        _logger.LogDebug("Initializing record index");
        var createTimer = Stopwatch.StartNew();
        var held = new HeldPlugins(
            _adapter, snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.GameRelease, _logger);
        Store.Store? fresh = null;
        OpenScope scope;
        try
        {
            // Held from the open, whose commit materializes the filter in force, to the swap: a filter set or
            // cleared meanwhile waits and lands on this store, and the filter's SQL never runs under _lock.
            using var writes = _gate.Enter();
            fresh = _storeFactory.Create(
                snapshot.GameRelease, snapshot.InstanceRoot, () => held.OpenedPlugins,
                () => Status.State == LoadOrderState.Ready, out heldElsewhere);
            if (fresh is null) return null;
            scope = ScopeOn(held, fresh, snapshot);
            lock (_lock)
            {
                _indexed.Clear();
                _conflictsComputed = false;
                _plannedCount = 0;
                _activeCount = 0;
                _collisionFailures = [];
                _scope = scope;
            }
            fresh = null;
        }
        finally
        {
            fresh?.Dispose();
        }
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Record index initialized in {ElapsedMs} ms", createTimer.ElapsedMilliseconds);
        }
        PublishStatus();
        return scope;
    }

    // The diff is computed first and without side effects, so a snapshot that moves nothing writes nothing and publishes no status.

    // Registrations the snapshot has stopped naming are dropped before anything new is opened, so a
    // freshly opened index file's last-run rows stop answering as early as possible. False when the
    // snapshot moved nothing.
    private bool ReconcileProgressively(OpenScope scope, LoadOrderSnapshot snapshot, CancellationToken token)
    {
        var (held, store) = (scope.Held, scope.Store);
        FailCollisions(snapshot.CollisionReasons());
        _readLanguage = snapshot.StringsLanguage;
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
            .Where(key => open.TryGetValue(key, out var h) && (h.Key != key || h.Path != wanted[key].Path || h.Provider != wanted[key].Provider || h.Registration != Registration.In(snapshot, key)))
            .ToList();
        var respelled = resolved.Select(r => r.Key).Where(key => held.IsSpelledOtherwise(key)).ToList();
        var derivations = store.Reads.GetDerivations();
        var stringsReads = store.Reads.GetStringsReads();
        // A plugin's text is read through its strings files, so other ones are a new read of it (ADR-0003).
        var restrung = resolved
            .Where(r => open.TryGetValue(r.Key, out var h)
                && (!h.Strings.Equals(r.Strings)
                    || !StringsStillRead(snapshot, r, derivations.TryGetValue(r.Key, out var d) ? d : null, stringsReads.GetValueOrDefault(r.Key))))
            .ToList();
        // A plugin in an error state whose bytes have not changed is not arriving: retrying it would
        // pay the failed parse again on every snapshot that merely mentions it.
        var arriving = resolved.Where(r => !open.ContainsKey(r.Key) && !scope.Failed.StillFailing(r)).ToList();
        // ADR-0007: which truth a plugin reads is its folder's answer, and the stamp
        // records the one its rows came from. A repository made or removed moves the first alone, and no
        // load-order difference above names them.
        var reDerived = resolved.Where(r => open.ContainsKey(r.Key) && TruthMoved(scope, r, derivations)).ToList();

        bool conflictsComputed;
        lock (_lock) conflictsComputed = _conflictsComputed;
        if (leaving.Count == 0 && moved.Count == 0 && respelled.Count == 0 && arriving.Count == 0 && reDerived.Count == 0 && restrung.Count == 0
            && conflictsComputed)
        {
            _logger.LogDebug("Load order snapshot is identical to what is held; nothing to reconcile");
            store.Commit(_ => store.SetStringsLanguage(_readLanguage));
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

        store.Commit(_ => store.SetStringsLanguage(_readLanguage));
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
        foreach (var plugin in restrung)
        {
            token.ThrowIfCancellationRequested();
            ReadOne(scope, plugin, state =>
                held.Open(plugin, Registration.In(snapshot, plugin.Key), snapshot).Holds(out var metadata, out var failure)
                    ? ReadWhole(scope, metadata, state)
                    : ReadOutcome.Failed(failure), token);
        }

        // Two distinct numbers: time to the first queryable plugin (the tree becomes usable) and
        // time to the winner sweep completing. Measured here rather than client-side, where the
        // 500 ms status poll caps the resolution.
        var timer = Stopwatch.StartNew();
        long? firstUsableMs = null;

        // One at a time: opening the whole set first would cost the same total time but make every
        // plugin wait on the slowest before any could be indexed, and bury each open failure.
        foreach (var plugin in arriving)
        {
            // At the top of each plugin rather than mid-plugin: a newer snapshot waits for the plugin in
            // hand (see _disposal).
            token.ThrowIfCancellationRequested();

            PluginMetadata? metadata = null;
            ReadOne(scope, plugin, state =>
                held.Open(plugin, Registration.In(snapshot, plugin.Key), snapshot).Holds(out metadata, out var failure)
                    ? RegisterOrIndex(scope, metadata, state, token)
                    : ReadOutcome.Failed(failure), token);
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
            ReadOne(scope, plugin, state => IndexOnePlugin(scope, metadata, state, token), token);
        }
    }

    // plugins.md, A row, Plugin: one plugin that cannot be read is that row's "Failed to read", never
    // the whole index's failure.
    private void ReadOne(OpenScope scope, RegisteredPlugin plugin, Func<ReadState, ReadOutcome> read, CancellationToken token)
    {
        try
        {
            if (scope.Failed.Read(plugin, read).Failure is { } failure)
                FailRead(scope, plugin.Key, failure);
        }
        catch (Exception ex) when (FailsOnePlugin(ex, token))
        {
            _logger.LogWarning(ex, "Could not read {Plugin} ({Origin})", plugin.Name, plugin.Origin);
            FailRead(scope, plugin.Key, ReadFailure(LoadFailureReason.Of(ex), scope.Store.DerivationOf(plugin.Key)));
        }
    }

    // plugins.md, A row, Plugin: each plugin of a case-only collision is that row's "Failed to read".
    private void FailCollisions(IReadOnlyList<(RegisteredPlugin Plugin, string Reason)> collisions)
    {
        IReadOnlyList<PluginLoadFailure> failures =
            [.. collisions.Select(c => new PluginLoadFailure(c.Plugin.Name, c.Plugin.Origin, c.Reason))];
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

    // Registers first: the record index's reads are scoped by registration, so validate would otherwise
    // compare an empty row set against a full tree. False falls through to a full index.
    private bool WarmRegister(OpenScope scope, PluginMetadata plugin, ReadState state, CancellationToken token)
    {
        scope.Store.Register(plugin);

        // A binary was already hashed against its stored claim when the record index file opened
        // (Store.ValidateAgainstDisk), so a second hash of every binary here would pay that whole cost
        // twice for no new answer.
        var truth = scope.Projector.TruthOf(plugin.Registered);
        if (truth != DerivedFrom.SourceTree) return scope.Store.DerivationOf(plugin.Key) is var derivedFrom && derivedFrom == truth
            && StringsStillRead(scope.LoadOrder, plugin.Registered, derivedFrom, scope.Store.IndexedStringsRead(plugin.Key));

        try
        {
            var report = scope.Projector.Validate(plugin.Registered, state);
            foreach (var failure in report.Failures)
                _logger.LogWarning("Validating {Plugin} at load: {Failure}", plugin.Name, failure);
            return !report.NeedsRebuild;
        }
        catch (Exception ex) when (RetriedByAWholeRead(ex, token))
        {
            // A validation that failed is no evidence the rows are still true: the whole read below
            // re-derives them and reports its own failure.
            _logger.LogWarning(ex, "Validating {Plugin} ({Origin}) at load failed; reading it whole", plugin.Name, plugin.Origin);
            return false;
        }
    }

    // A failure that says what the plugin already said publishes nothing.
    private void FailRead(OpenScope scope, PluginAddress key, string reason, string? diagnosis = null)
    {
        if (scope.Held.SetFailure(key, reason, diagnosis)) PublishStatus();
    }

    private void FailRead(OpenScope scope, PluginAddress key, LoadFailure failure) =>
        FailRead(scope, key, ReadFailure(failure.Reason, scope.Store.DerivationOf(key)), failure.IsDiagnosis ? failure.Reason : null);

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
    // indexed; ADR-0015 validates a compiled plugin by content on that same warm path.
    private ReadOutcome RegisterWarmOrIndex(OpenScope scope, PluginMetadata plugin, ReadState state, CancellationToken token)
    {
        if (scope.Store.IndexedContentHash(plugin.Key) != null && WarmRegister(scope, plugin, state, token))
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

    // ADR-0007; HeldPlugins still reads a compiled plugin's metadata off its binary.

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
            if (scope.Projector.Ingest(plugin, _disposal.Token) is not { } stopped) return ReadOutcome.Read;
            _logger.LogWarning("Could not ingest {Plugin} from its source tree; reading its binary: {Reason}", plugin.Name, stopped.Reason);
            stoppedAt = ReadOutcome.StoppedAt(stopped);
        }
        catch (Exception ex) when (FailsOnePlugin(ex, token))
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
    private static bool BinaryStandsIn(Store.Store store, PluginAddress key, ReadState state) =>
        store.DerivationOf(key) == DerivedFrom.BinaryForUnreadableSource
        && state.Binary is { } binary && store.IndexedContentHash(key) == binary;

    // ADR-0005: the binary reaches the record index as documents, through the adapter's own door,
    // never as a mod this side holds.
    private ReadOutcome IndexFromBinary(OpenScope scope, PluginMetadata plugin, DerivedFrom derivedFrom)
    {
        var modPath = ModPathOf(plugin.Path);
        // Taken before the read, as the binary's hash is: strings changed during it are then read again.
        var stringsRead = plugin.IsLocalized ? StringsReadBy(scope.LoadOrder, plugin.Registered) : null;
        if (!_adapter.OpenDocuments(modPath, scope.LoadOrder, scope.Store.Schemas, plugin.Strings).Holds(out var opened, out var failure))
        {
            _logger.LogWarning(failure.Error, "Could not read {Plugin} ({Origin}): {Reason}", plugin.Name, plugin.Origin, failure.Reason);
            return ReadOutcome.Failed(failure);
        }

        using var documents = opened;
        if (scope.Store.IndexBinary(documents, plugin, plugin.Path, derivedFrom, stringsRead, _disposal.Token) is not { } refused) return ReadOutcome.Read;
        _logger.LogWarning("Could not read {Plugin} ({Origin}): {Reason}", plugin.Name, plugin.Origin, refused.Reason);
        return ReadOutcome.Failed(refused);
    }

    private static ModPath ModPathOf(string path) => new(ModKey.FromFileName(Path.GetFileName(path)), path);

    // A binary's rows hold its texts as its strings gave them. A tree's hold their own, and a plugin not localized has none.
    private bool StringsStillRead(LoadOrderSnapshot loadOrder, RegisteredPlugin plugin, DerivedFrom? derivedFrom, string? read) =>
        derivedFrom is null or DerivedFrom.SourceTree || read is null || read == StringsReadBy(loadOrder, plugin);

    // The language a read shows its texts in, and each place it takes its strings from, by the stamp Mod Management
    // handed with it, or why a place could not be read (ADR-0003).
    private string StringsReadBy(LoadOrderSnapshot loadOrder, RegisteredPlugin plugin) =>
        $"{_readLanguage}\n" + (_adapter.StringsPlacesOf(ModPathOf(plugin.Path), loadOrder, plugin.Strings).Holds(out var places, out var failure)
            ? string.Join('\n', places.Select(place => $"{Store.Store.RelativeWithin(loadOrder.DataFolderPath, place)}|{plugin.Strings.StampOf(place) ?? loadOrder.StampOf(place)}"))
            : failure.Reason);

    // ADR-0015.
    private void ValidateIndex(CancellationToken token)
    {
        var scope = RequireScope();
        // A plugin not held failed to open, and the reconcile opens it again once its bytes change.
        Validate(scope, scope.Held.Plugins, token);
    }

    // Each plugin read whole lands in its own transaction, so one read before a throw is listed too:
    // in a finally, after the commit's own finally has landed it.
    private void Validate(OpenScope scope, IEnumerable<PluginMetadata> plugins, CancellationToken token)
    {
        var landed = new List<PluginMetadata>();
        try
        {
            scope.Store.Commit(_ =>
            {
                foreach (var plugin in plugins)
                {
                    token.ThrowIfCancellationRequested();
                    if (ValidateOne(scope, plugin, token)) landed.Add(plugin);
                }
            });
        }
        finally
        {
            ListLanded(landed);
        }
    }

    // Listed as RegisterOrIndex lists an arriving plugin, once the commit that read it has landed.
    private void ListLanded(List<PluginMetadata> landed)
    {
        bool listed;
        lock (_lock)
        {
            var unlisted = landed.Select(p => p.Key).Where(key => !_indexed.Contains(key, PluginAddress.Comparer)).ToList();
            _indexed.AddRange(unlisted);
            listed = unlisted.Count > 0;
        }
        if (listed) PublishStatus();
    }

    // plugins.md, A row, Plugin, "Failed to read": a plugin that cannot be read is flagged, and the
    // rest are still validated. A failed one is read whole again once what it reads from changed.
    // True when read whole.
    private bool ValidateOne(OpenScope scope, PluginMetadata plugin, CancellationToken token)
    {
        var (held, store) = (scope.Held, scope.Store);
        var key = plugin.Key;
        var holdsTree = scope.Projector.TruthOf(plugin.Registered) == DerivedFrom.SourceTree;
        try
        {
            if (!holdsTree && !_adapter.Exists(plugin.Path))
            {
                if (store.IndexedContentHash(key) is not null) store.Unindex(key);
                return false;
            }

            // Rows a failed read left say nothing of what the plugin now reads from.
            if (held.IsHeldWithAFailure(key) || scope.Failed.Holds(key))
            {
                return !scope.Failed.StillFailing(plugin.Registered) && ReindexHeldPlugin(scope, plugin);
            }

            var readWhole = false;
            scope.Failed.Read(plugin.Registered, state =>
            {
                readWhole = MustReadWhole(scope, plugin, holdsTree, state, token);
                return ReadOutcome.Read;
            });
            return readWhole && ReindexHeldPlugin(scope, plugin);
        }
        catch (Exception ex) when (FailsOnePlugin(ex, token))
        {
            _logger.LogWarning(ex, "Could not validate {Plugin} ({Origin})", key.Name, key.Origin);
            // A re-read that failed has named its own failure.
            if (!held.IsHeldWithAFailure(key)) FailRead(scope, key, ValidationFailure(holdsTree, LoadFailureReason.Of(ex)));
            return false;
        }
    }

    // When the rows cannot be brought true here. A tree that cannot be read is read whole, which reads
    // the binary in its place and names what stopped it.
    private bool MustReadWhole(OpenScope scope, PluginMetadata plugin, bool holdsTree, ReadState state, CancellationToken token)
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
            // A non-compiled plugin's rows went with its file, and the file is back.
            return report.NeedsRebuild || (!holdsTree && scope.Store.IndexedContentHash(key) is null);
        }
        catch (Exception ex) when (RetriedByAWholeRead(ex, token))
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
    private string? ValidateHeld(CancellationToken token, out bool busy) => ValidationFailure(() => ValidateIndex(token), token, out busy);

    private string? ValidationFailure(Action validate, CancellationToken token, out bool busy)
    {
        busy = false;
        if (_disposal.IsCancellationRequested) return null;
        lock (_lock)
        {
            if (_scope is null) return null;
        }
        try
        {
            validate();
            return null;
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // Busy, not broken: validation is idempotent, and the next snapshot validates again.
            _logger.LogWarning(ex, "Could not validate the record index while another write held it; it is re-checked at the next snapshot");
            busy = true;
            return null;
        }
        catch (Exception ex) when (!CancelledBy(ex, token))
        {
            // Every type, out of memory included: the failure becomes status data (plugins.md,
            // States, story 6), and the next snapshot tries again.
            _logger.LogError(ex, "Validating the record index failed unexpectedly");
            return FailureAfterReopening(ex);
        }
    }

    // ADR-0007: the read a first index runs, so a re-read produces the same rows by construction. A
    // failed read is recorded with what it read from and rethrown, so it is not read again until that
    // changes.
    private bool ReindexHeldPlugin(OpenScope scope, PluginMetadata plugin)
    {
        var key = plugin.Key;
        ReadOutcome outcome;
        try
        {
            outcome = scope.Store.Commit(_ => scope.Failed.Read(plugin.Registered, state => ReadWhole(scope, plugin, state)));
        }
        catch (Exception ex)
        {
            FailRead(scope, key, ReadFailure(LoadFailureReason.Of(ex), scope.Store.DerivationOf(key)));
            throw;
        }
        if (outcome.Failure is { } failure)
        {
            FailRead(scope, key, failure);
            return false;
        }
        if (scope.Held.ClearFailure(key)) PublishStatus();
        return true;
    }

    private ReadOutcome ReadWhole(OpenScope scope, PluginMetadata plugin, ReadState state) => scope.Store.Commit(projection =>
    {
        var read = IndexOnePlugin(scope, plugin, state, CancellationToken.None);
        if (read.Failure is null) projection.PluginChanged(plugin.Key);
        return read;
    });

    /// <summary>Runs <paramref name="write"/> on the store in force inside the write gate, then the scope, so it
    /// races no write and no reconcile closes the store beneath it. With no store, runs
    /// <paramref name="noStore"/> there instead.</summary>
    internal T InForce<T>(Func<GatedStore, T> write, Func<T> noStore)
    {
        using var _ = _gate.Enter();
        lock (_lock) return _scope is { } scope ? write(new GatedStore(scope.Store, IndexScope.Of(scope.Held))) : noStore();
    }

    /// <summary>Hands <paramref name="whileClosed"/> the file with the store closed and no reconcile running, then
    /// reconciles the load order held unless it refuses. False, having run nothing, when a read outlived the
    /// close: the store is reconciled back.</summary>
    internal bool WhileClosed(Func<ClosedStore, string?> whileClosed, out string? heldElsewhere)
    {
        heldElsewhere = null;
        string? failure = null;
        EnterExclusive();
        try
        {
            var handedOut = Sequence;
            if (!Close())
            {
                AskReconcile();
                return false;
            }
            try { heldElsewhere = whileClosed(new ClosedStore(_storeFactory, handedOut)); }
            catch (IndexFaultException ex) { failure = ex.Message; }
            var refusal = heldElsewhere;
            var failed = failure;
            Swap(standing => standing with { HeldElsewhere = refusal, Failure = failed });
        }
        finally { ExitExclusive(); }
        if (heldElsewhere is null && failure is null) AskReconcile();
        else PublishStatus();
        return true;
    }

    public void Subscribe()
    {
        _holder.Arrived += OnArrived;
        _unsaved.Arrived += ValidateTreesHolding;
    }

    private void OnArrived(LoadOrderSnapshot snapshot, long version) => AskReconcile();

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
            lock (_lock) closing = DetachCurrent();
            readsEnded = _storeFactory.Close(closing?.Store);
        }
        finally { ExitExclusive(); }

        PublishStatus();
        return readsEnded;
    }

    public void Dispose()
    {
        _holder.Arrived -= OnArrived;
        _unsaved.Arrived -= ValidateTreesHolding;

        lock (_turns) _disposed = true;

        _disposal.Cancel();
        if (!EnterExclusiveWithin(CloseLimit))
        {
            _logger.LogWarning(
                "Closed with a read of the record index still running after {Seconds}s; the process's exit releases its file",
                CloseLimit.TotalSeconds);
            return;
        }
        try
        {
            OpenScope? closing;
            lock (_lock) closing = DetachCurrent();
            lock (_turns)
            {
                // EndReconcile already clears this on every reconcile's own exit path; this is the
                // exclusive-holder's own backstop, not the common case.
                _reconcileCancellation?.Dispose();
                _reconcileCancellation = null;
            }
            closing?.Store.Dispose();
            _storeFactory.Dispose();
        }
        finally { ExitExclusive(); }
        _disposal.Dispose();
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
        _standing = _standing.WithoutRefusals();
        return detached;
    }
}
