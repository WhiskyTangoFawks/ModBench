using System.Diagnostics;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Store;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex;

/// <summary>Brings the Store to the load order (ADR-0013), and validates each plugin a change names, or every plugin at a
/// check of the disk (ADR-0001). It holds the open plugins, the progress and the scope.</summary>
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
        long memoryLimit,
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
            memoryLimit, AskCheck, loggerFactory?.CreateLogger<StoreFactory>(), timeProvider);
    }

    // Lock order: _lock, then the Store's projection lock, which a projection's announcements run
    // under. An announcement reads the record index's own Sequence, never this class's Sequence, Status or
    // RequireReads, which take _lock.
    private readonly Lock _lock = new();
    private OpenScope? _scope;

    // The reconcile's own progress. Guarded by _lock like _scope: written by the reconciling thread
    // as each plugin lands, read by whoever asks for Status meanwhile.
    private readonly List<PluginAddress> _indexed = [];
    private readonly Dictionary<PluginAddress, (string? Path, string? Hash)> _failedFileHashes = new(PluginAddress.Comparer);
    private bool _conflictsComputed;
    private bool _validating;
    private int _plannedCount;
    private int _activeCount;
    private (int Planned, int Active)? _closedForRebuild;

    /// <summary>A rebuild has the index closed, and the load order is still the one it holds: no plugin is opened.</summary>
    public bool Rebuilding
    {
        get { lock (_lock) return _closedForRebuild is not null; }
    }
    private IReadOnlyList<PluginLoadFailure> _collisionFailures = [];
    private sealed record Standing(long Version, string? HeldElsewhere, string? Failure, string? ReReadFailure)
    {
        public Standing WithoutRefusals() => this with { HeldElsewhere = null, Failure = null, ReReadFailure = null };
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

    private (long Version, LoadOrderState State, string? Message, bool Validating) _told;

    // Every site that changes what Status reports calls this after. A status counts as told
    // only once Publish returns. _lock is reentrant, so this is safe from inside a lock a caller holds.
    private void PublishStatus()
    {
        lock (_lock)
        {
            var status = Status;
            _notifications?.Publish(new LoadOrderStatusNotification(status));
            _told = (status.Version, status.State, status.Message, status.Validating);
        }
    }

    // A status whose publish faulted is told by the next attempt's close.
    private bool Untold()
    {
        lock (_lock)
        {
            var status = Status;
            return _told != (status.Version, status.State, status.Message, status.Validating);
        }
    }

    // Two mechanisms, because one is not enough: the token asks the reconcile loop to stop, the
    // exclusive lock waits until it has. Cancelling without draining would let a teardown dispose
    // the store connection mid-write, a native crash.

    // Deliberately not _lock: the reconciling thread takes _lock on every plugin, so a waiter
    // holding it could never be signalled.
    private readonly Lock _exclusive = new();
    // Only disposal stops a plugin read partway, inside the one transaction its rows land in.
    private readonly CancellationTokenSource _disposal = new();

    private bool _reconcileAsked;
    private bool _checkAsked;
    private readonly List<string> _handed = [];
    private readonly HashSet<PluginAddress> _named = new(PluginAddress.Comparer);
    private readonly Dictionary<PluginAddress, AskedFiles> _namedFiles = new(PluginAddress.Comparer);
    private readonly List<Hand> _namedHands = [];
    private readonly List<TaskCompletionSource<string?>> _checkHands = [];
    private bool _working;
    private bool _validatingTurn;
    private bool _disposed;
    private CancellationTokenSource? _reconcileCancellation;

    // Guards the fields above. Not _lock, so an arrival never waits on a status read or publish; none
    // of this class's other locks is taken inside it.
    private readonly Lock _turns = new();

    // Guarded by _lock.
    private bool _openedUnchecked;

    // LoadOrder: the snapshot the scope last reconciled, which holds the masters a plugin is read against.
    private sealed record OpenScope(HeldPlugins Held, Store.Store Store, Projector Projector, FailedReads Failed, LoadOrderSnapshot LoadOrder);

    // Takes the exclusive right to tear down, waiting out the worker's turn and cancelling its reconcile.
    // Always paired with ExitExclusive in a finally.
    private void EnterExclusive()
    {
        CancelInFlight();
        _exclusive.Enter();
    }

    // Cancel and dispose both happen under _turns, so a token can never be cancelled after it has
    // been disposed.
    private void CancelInFlight()
    {
        lock (_turns)
        {
            if (_reconcileCancellation is not { } inFlight) return;
            inFlight.Cancel();
        }
        _logger.LogDebug("Asked the reconcile in flight to stop");
    }

    private void ExitExclusive() => _exclusive.Exit();

    // A read that ignores cancellation, as a Mutagen read can, would otherwise hold closing mEdit, and
    // the record index file with it, for ever.
    private static readonly TimeSpan CloseLimit = TimeSpan.FromSeconds(10);

    private bool EnterExclusiveWithin(TimeSpan limit)
    {
        CancelInFlight();
        var deadline = _timeProvider.GetUtcNow() + limit;
        while (!_exclusive.TryEnter(SequencePollInterval))
        {
            if (_timeProvider.GetUtcNow() >= deadline) return false;
        }
        return true;
    }

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: before the first reconcile
    /// the Index has opened no store to read.</summary>
    public RelationReads RequireReads() => RequireScope().Store.Reads;

    public RelationReads RequireWholeSetReads()
    {
        var status = Status;
        if (status.State == LoadOrderState.Ready) return RequireReads();
        if (_holder.Held is null) throw new NoLoadOrderException();
        throw new IndexNotReadyException(
            status.Message is { } reason ? $"mEdit's record index is not ready: {reason}" : "mEdit's record index is not ready.");
    }

    // The failure is of the bytes that were there (ADR-0003): a file rewritten since is not yet read again.
    private void RememberFileFailedAt(OpenScope scope, PluginAddress key)
    {
        var path = _holder.Held?.Snapshot.Plugins.FirstOrDefault(plugin => PluginAddress.Comparer.Equals(plugin.Key, key))?.Path;
        var hash = path is null ? null : scope.Store.FileContentHash(path);
        lock (_lock) _failedFileHashes[key] = (path, hash);
    }

    /// <summary>Asked of the file now on disk, not the last snapshot (ADR-0003); a plugin nothing on disk backs is as it was read.</summary>
    public PluginIndexedState IndexedState(PluginAddress key)
    {
        var scope = RequireScope();
        lock (_lock)
        {
            if (scope.Held.FailureOf(key) is { } failed)
            {
                var stillTheFileItFailedOn = _failedFileHashes.TryGetValue(key, out var at) && at.Path is not null && at.Hash is not null
                    && scope.Store.FileContentHash(at.Path) == at.Hash;
                return stillTheFileItFailedOn ? new(PluginIndexing.ReadFailed, failed.Reason) : new(PluginIndexing.NotYet);
            }
            if (!_indexed.Exists(held => PluginAddress.Comparer.Equals(held, key))) return new(PluginIndexing.NotYet);
        }
        var asOnDisk = scope.Store.IndexedFile(key) is not { } claim || scope.Store.FileContentHash(claim.FilePath) == claim.ContentHash;
        return new(asOnDisk ? PluginIndexing.AsOnDisk : PluginIndexing.NotYet);
    }

    /// <summary>Each plugin of the load order held, by what the reconcile has done with it.</summary>
    public IReadOnlyList<IndexOfPlugin> IndexOfPlugins()
    {
        var plugins = _holder.Held?.Snapshot.Plugins ?? throw new NoLoadOrderException();
        if (Rebuilding) return [.. plugins.Select(plugin => new IndexOfPlugin(plugin.Name, plugin.Origin, IndexOfPluginState.Pending))];
        var scope = RequireScope();
        lock (_lock)
        {
            var failures = new List<PluginLoadFailure>([.. scope.Held.Failures, .. _collisionFailures]);
            return [.. plugins.Select(plugin =>
            {
                var failure = failures.Find(f => f.Name == plugin.Name && f.Origin == plugin.Origin);
                if (failure is not null) return new IndexOfPlugin(plugin.Name, plugin.Origin, IndexOfPluginState.Failed, failure.Reason, failure.Diagnosis);
                var indexed = _indexed.Exists(held => PluginAddress.Comparer.Equals(held, plugin.Key));
                return new IndexOfPlugin(plugin.Name, plugin.Origin, indexed ? IndexOfPluginState.Indexed : IndexOfPluginState.Pending);
            })];
        }
    }

    public IReadOnlyList<SourceFileFailure> SourceFileFailures
    {
        get { lock (_lock) return _scope?.Failed.SourceFileFailures ?? []; }
    }

    public IReadOnlyList<(PluginAddress Plugin, string Reason)> UnreadableBinaries
    {
        get { lock (_lock) return _scope?.Failed.UnreadableBinaries ?? []; }
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
                    held = _closedForRebuild is { } rebuilding
                        ? new LoadOrderStatus(LoadOrderState.Reconciling, rebuilding.Planned, rebuilding.Active, [], false, [], Version: _standing.Version)
                        : LoadOrderStatus.None with { Version = _standing.Version };
                }
                else
                {
                    var state = _conflictsComputed && !_validating ? LoadOrderState.Ready : LoadOrderState.Reconciling;
                    held = new LoadOrderStatus(state, _plannedCount, _activeCount, [.. _indexed], _conflictsComputed, [.. _scope.Held.Failures, .. _collisionFailures], Version: _standing.Version, Validating: ValidationAsked());
                }

                if (_standing.HeldElsewhere is { } heldElsewhere)
                    return held with { State = LoadOrderState.HeldElsewhere, Message = heldElsewhere };
                if ((_standing.Failure ?? _standing.ReReadFailure) is { } failure)
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

    // ADR-0013.
    private void AskReconcile()
    {
        lock (_turns)
        {
            _reconcileAsked = true;
            WakeWorker();
        }
    }

    // ADR-0001: the files a change names are read again, a plugin it names with no file is read whole, and a change that
    // names none checks every plugin.
    private void OnChange(IReadOnlyCollection<PluginChange>? changes)
    {
        if (changes is null)
        {
            AskCheck();
            return;
        }
        lock (_turns)
        {
            foreach (var (plugin, files) in changes) Name(plugin, files, []);
            WakeWorker();
        }
    }

    // Guarded by _turns.
    private void Name(PluginAddress plugin, IReadOnlyList<string>? files, IReadOnlyList<WrittenDocument> documents)
    {
        if (files is null)
        {
            _named.Add(plugin);
            return;
        }
        if (!_namedFiles.TryGetValue(plugin, out var asked)) _namedFiles[plugin] = asked = new AskedFiles();
        asked.Add(files, documents);
    }

    public Task<string?> Hold(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel)
    {
        var held = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_turns)
        {
            if (_disposed) held.SetResult(Closed);
            else if (written is null)
            {
                _checkHands.Add(held);
                AskCheck();
            }
            else
            {
                _namedHands.Add(new Hand(held, written));
                foreach (var (plugin, files, documents, _) in written) Name(plugin, files, documents);
                WakeWorker();
            }
        }
        return held.Task.WaitAsync(cancel);
    }

    private sealed record Hand(TaskCompletionSource<string?> Held, IReadOnlyList<HandedPlugin> Plugins);

    private const string Closed = "mEdit's record index closed before it read the plugin source mEdit wrote.";

    private static void Answer(List<TaskCompletionSource<string?>> hands, string? unread)
    {
        foreach (var hand in hands) hand.TrySetResult(unread);
    }

    // A path named without its document is read from its file, so another program's write in the stamp's tick is not
    // taken for mEdit's (ADR-0003).
    private sealed class AskedFiles
    {
        private static readonly StringComparer PathComparer = StringComparer.FromComparison(FilePaths.Comparison);
        private readonly Dictionary<string, WrittenDocument> _documents = new(PathComparer);
        private readonly HashSet<string> _fromFile = new(PathComparer);

        public List<string> Files { get; } = [];

        public IReadOnlyList<WrittenDocument> Handed => [.. _documents.Where(document => !_fromFile.Contains(document.Key)).Select(document => document.Value)];

        public void Add(IReadOnlyList<string> files, IReadOnlyList<WrittenDocument> documents)
        {
            Files.AddRange(files);
            foreach (var document in documents) _documents[Path.GetFullPath(document.Path)] = document;
            _fromFile.UnionWith(files.Select(Path.GetFullPath).Where(path => !documents.Any(document => PathComparer.Equals(Path.GetFullPath(document.Path), path))));
        }
    }

    private void AskCheck()
    {
        lock (_turns)
        {
            _checkAsked = true;
            WakeWorker();
        }
    }

    // Lock order: _lock, then _turns. Nothing holding _turns takes _lock.
    private bool ValidationAsked()
    {
        lock (_turns) return _validatingTurn || _checkAsked || _handed.Count > 0 || _named.Count > 0 || _namedFiles.Count > 0;
    }

    // A handed path is validated as a change on disk is.
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
            TellIfUntold();
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
            lock (_turns) _validatingTurn = false;
            TellIfUntold();
        }
    }

    private void TellIfUntold()
    {
        try { if (Untold()) PublishStatus(); }
        catch (Exception publishFault) when (!CancelledBy(publishFault, CancellationToken.None))
        {
            _logger.LogError(publishFault, "Publishing the status around a turn failed");
        }
    }

    private Action? NextTurn()
    {
        lock (_turns)
        {
            if (_disposed || (!_reconcileAsked && !_checkAsked && _handed.Count == 0 && _named.Count == 0 && _namedFiles.Count == 0 && _namedHands.Count == 0))
            {
                _working = false;
                return null;
            }
            if (_reconcileAsked || _checkAsked)
            {
                var check = _checkAsked;
                List<TaskCompletionSource<string?>> checking = check ? [.. _checkHands] : [];
                if (check) _checkHands.Clear();
                _validatingTurn = check;
                (_reconcileAsked, _checkAsked) = (false, false);
                return () => ReconcileHeld(check, checking);
            }
            List<string> paths = [.. _handed];
            _handed.Clear();
            _validatingTurn = true;
            return TakeNamed(paths, _ => false);
        }
    }

    // Guarded by _turns. Leaves the names of plugins still to land, and every hand naming one with each plugin it names.
    private Action? TakeNamed(List<string> paths, Func<PluginAddress, bool> stillToLand)
    {
        HashSet<PluginAddress> waiting = new(_named.Concat(_namedFiles.Keys).Where(stillToLand), PluginAddress.Comparer);
        List<Hand> handsWaiting;
        int waited;
        do
        {
            waited = waiting.Count;
            handsWaiting = [.. _namedHands.Where(hand => hand.Plugins.Any(handed => waiting.Contains(handed.Plugin)))];
            waiting.UnionWith(handsWaiting.SelectMany(hand => hand.Plugins.Select(handed => handed.Plugin)));
        }
        while (waiting.Count > waited);

        HashSet<PluginAddress> named = new(_named.Where(key => !waiting.Contains(key)), PluginAddress.Comparer);
        Dictionary<PluginAddress, AskedFiles> files = _namedFiles.Where(asked => !waiting.Contains(asked.Key)).ToDictionary(PluginAddress.Comparer);
        List<Hand> hands = [.. _namedHands.Except(handsWaiting)];
        if (paths.Count == 0 && named.Count == 0 && files.Count == 0 && hands.Count == 0) return null;
        _named.ExceptWith(named);
        foreach (var key in files.Keys) _namedFiles.Remove(key);
        _namedHands.RemoveAll(hands.Contains);
        return () => ValidateAndPublish(paths, named, files, hands);
    }

    private bool NamedWaits()
    {
        lock (_turns) return _named.Count > 0 || _namedFiles.Count > 0 || _namedHands.Count > 0;
    }

    // ADR-0029: long work lands what was named meanwhile between its steps, except a plugin still to land, and nothing while
    // a newer load order waits. A landing that reopened the store stops the work with its failure.
    private bool LandNamedBetween(OpenScope scope, Func<PluginAddress, bool> stillToLand)
    {
        Action? landing;
        bool validating;
        var newerWaits = !ReferenceEquals(_holder.Held?.Snapshot, scope.LoadOrder);
        lock (_turns)
        {
            if (newerWaits || TakeNamed([], stillToLand) is not { } taken) return false;
            landing = taken;
            (validating, _validatingTurn) = (_validatingTurn, true);
        }
        try { landing(); }
        finally { lock (_turns) _validatingTurn = validating; }
        lock (_lock)
        {
            if (!ReferenceEquals(_scope, scope)) throw new IndexFaultException(_standing.ReReadFailure ?? NotReopened);
        }
        return true;
    }

    private void ValidateAndPublish(
        List<string> paths, HashSet<PluginAddress> named, Dictionary<PluginAddress, AskedFiles> files, List<Hand> hands)
    {
        var moved = false;
        string? unread = Stopped;
        HashSet<PluginAddress> read = new(PluginAddress.Comparer);
        _exclusive.Enter();
        try
        {
            var failure = ValidationFailure(() => read.UnionWith(ValidateNamed(paths, named, files)), CancellationToken.None, out var busy);
            moved = Swap(standing => standing with { ReReadFailure = failure });
            unread = NotReadBecause(failure ?? (busy ? Busy : null));
        }
        finally
        {
            foreach (var hand in hands) hand.Held.TrySetResult(unread ?? WhyNotHeld(hand.Plugins, read));
            _exclusive.Exit();
        }
        if (moved) PublishStatus();
    }

    private const string Stopped = "mEdit's record index stopped before it read the plugin source mEdit wrote.";

    private const string Busy = "another write held the record index, and the next check of the disk reads it.";

    private static string? NotReadBecause(string? reason) => reason is null ? null : NotReadYet + reason;

    private string? WhyNotHeld(IReadOnlyList<HandedPlugin> plugins, HashSet<PluginAddress> read)
    {
        OpenScope? scope;
        lock (_lock) scope = _scope;
        if (scope is null) return Stopped;
        List<string> unheld = [.. plugins.DistinctBy(handed => handed.Plugin, PluginAddress.Comparer).Select(handed => WhyNotHeld(scope, handed, read)).OfType<string>()];
        return unheld.Count == 0 ? null : NotReadYet + string.Join(" ", unheld);
    }

    private string? WhyNotHeld(OpenScope scope, HandedPlugin handed, HashSet<PluginAddress> read)
    {
        var plugin = handed.Plugin;
        if (scope.LoadOrder.Plugin(plugin) is not { } registered) return $"the load order does not hold {plugin.Name} ({plugin.Origin}).";
        if (handed.OfSource && scope.Projector.TruthOf(registered) != DerivedFrom.SourceTree)
        {
            return _source.WhySourceDoesNotRead(registered) is { } unreadable
                ? $"{plugin.Name} ({plugin.Origin}): {unreadable.Reason}"
                : $"the load order names no plugin source of {plugin.Name} ({plugin.Origin}), so its rows are read from its binary.";
        }
        if (scope.Held.FailureOf(plugin) is { } failed) return $"{plugin.Name} ({plugin.Origin}): {failed.Reason}";
        if (scope.Failed.WhyTreeStopped(plugin) is { } stopped) return $"{plugin.Name} ({plugin.Origin}): {stopped.Reason}";
        return read.Contains(plugin) ? null : $"{plugin.Name} ({plugin.Origin}) was not read.";
    }

    private List<PluginAddress> ValidateNamed(List<string> paths, HashSet<PluginAddress> named, Dictionary<PluginAddress, AskedFiles> files)
    {
        var scope = RequireScope();
        named.UnionWith(paths
            .Select(path => _source.Touching(scope.LoadOrder, path))
            .OfType<PathAnswer.Touches>()
            .SelectMany(touches => touches.Plugins)
            .Select(plugin => plugin.Key));
        List<PluginAddress> readAlone = [.. scope.Held.Plugins
            .Where(plugin => !named.Contains(plugin.Key) && files.TryGetValue(plugin.Key, out var asked) && ReadFiles(scope, plugin, asked))
            .Select(plugin => plugin.Key)];
        named.UnionWith(files.Keys.Where(key => !readAlone.Contains(key, PluginAddress.Comparer)));
        var holding = scope.Held.Plugins.Where(plugin => named.Contains(plugin.Key)).ToList();
        if (holding.Count > 0 || scope.Store.SweepOwed) Validate(scope, holding, CancellationToken.None);
        // A plugin that failed to open is not held: the reconcile opens it again.
        if (scope.LoadOrder.Plugins.Any(plugin => named.Contains(plugin.Key) && scope.Held.Find(plugin.Key) is null)) AskReconcile();
        return [.. holding.Select(plugin => plugin.Key), .. readAlone];
    }

    // A read that stands on a failure is cleared only by reading the plugin whole, as is one the named read fails on.
    private bool ReadFiles(OpenScope scope, PluginMetadata plugin, AskedFiles asked)
    {
        if (scope.Held.IsHeldWithAFailure(plugin.Key) || scope.Failed.Holds(plugin.Key)) return false;
        try
        {
            return scope.Projector.ReadFiles(plugin.Registered, asked.Files, asked.Handed);
        }
        catch (Exception ex) when (FailsOnePlugin(ex, CancellationToken.None))
        {
            _logger.LogWarning(ex, "Could not read the files named of {Plugin} ({Origin}), so it is read whole", plugin.Name, plugin.Origin);
            return false;
        }
    }

    // Disposal is read with the exclusive right held, which Dispose takes after setting it, so no
    // reconcile opens a store after Dispose.
    private void ReconcileHeld(bool check, List<TaskCompletionSource<string?>> checking)
    {
        string? unread = Stopped;
        try
        {
            unread = Reconcile(() =>
            {
                lock (_turns) return _disposed ? null : _holder.Held;
            }, check);
        }
        finally { Answer(checking, unread); }
    }

    // ADR-0013's one verb, then, for a check of the disk, every plugin validated. The arrival is read once the
    // exclusive right is held, so a refill reconciles the load order held then. Null reconciles nothing.
    private string? Reconcile(Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival, bool check)
    {
        bool arrived;
        string? refusal;
        bool busy;
        try
        {
            arrived = ReconcileOrRefuse(arrival, check, out refusal, out busy);
        }
        catch (OperationCanceledException ex)
        {
            // Superseded by a rebuild, which publishes the status itself, or by disposal.
            _logger.LogInformation(ex, "Load order reconcile was superseded before it completed");
            return Stopped;
        }
        if (!arrived) return Stopped;
        return NotReadBecause(refusal ?? (busy ? Busy : null));
    }

    private const string NotReadYet = "mEdit's record index has not read the plugin source mEdit wrote: ";

    // A superseded reconcile throws and publishes nothing. The closing swap and its publish share one
    // hold of _lock, so no reader sees a version before the status answering it.
    private bool ReconcileOrRefuse(
        Func<(LoadOrderSnapshot Snapshot, long Version)?> arrival, bool check, out string? refusal, out bool busy)
    {
        busy = false;
        _exclusive.Enter();
        var token = CancellationToken.None;
        var superseded = false;
        var progressed = false;
        long version = 0;
        string? heldElsewhere = null;
        string? failure = null;
        refusal = null;
        try
        {
            if (arrival() is not { } resolved) return false;
            var (snapshot, arrived) = resolved;
            version = arrived;
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
            lock (_lock) check |= _openedUnchecked;
            if (!check) return true;
            failure = ValidateHeld(token, out busy);
            if (!busy) lock (_lock) _openedUnchecked = false;
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
            refusal = heldElsewhere ?? failure;
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
            return IndexWriteGate.NotDrained(NotReopened, "It is retried at the next check of the disk.");

        var snapshot = current.LoadOrder;
        var held = current.Held;
        // Held to the swap, as EnsureScope holds it.
        using (_gate.Enter())
        {
            var fresh = _storeFactory.Create(
                snapshot.GameRelease, snapshot.InstanceRoot, () => held.OpenedPlugins,
                () => Status.State == LoadOrderState.Ready, out var heldElsewhere);
            if (fresh is null) return $"{NotReopened}: {heldElsewhere ?? "another process holds it"}";
            lock (_lock) (_scope, _openedUnchecked, _conflictsComputed) = (ScopeOn(held, fresh, snapshot), true, false);
        }
        PublishStatus();
        return null;
    }

    private bool FailsOnePlugin(Exception ex, CancellationToken token) =>
        ex is not IndexFaultException { Fault: IndexFault.Invalidated } && !CancelledBy(ex, token);

    // A whole read after a validation that ran out of memory would run out again.
    private bool RetriedByAWholeRead(Exception ex, CancellationToken token) =>
        !IndexFaultException.RanOutOfMemory(ex) && FailsOnePlugin(ex, token);

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
            failure = IndexWriteGate.NotDrained(NotReopened, "It is retried at the next check of the disk.");
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
                _closedForRebuild = null;
                _scope = scope;
                _openedUnchecked = true;
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
        _adapter.KeepStateOf(resolved.Select(r => r.Path).ToHashSet(StringComparer.Ordinal));
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

        HashSet<PluginAddress> toArrive = new(arriving.Select(plugin => plugin.Key), PluginAddress.Comparer);
        ReadEachLandingBetween(scope, reDerived, toArrive.Contains, plugin => ReDerive(scope, plugin, token), token);
        ReadEachLandingBetween(scope, restrung, toArrive.Contains, plugin =>
            ReadOne(scope, plugin, state =>
                held.Open(plugin, Registration.In(snapshot, plugin.Key), snapshot).Holds(out var metadata, out var failure)
                    ? ReadWhole(scope, metadata, state)
                    : ReadOutcome.Failed(failure), token), token);

        // Two distinct numbers: time to the first queryable plugin (the tree becomes usable) and
        // time to the winner sweep completing. Measured here rather than client-side, where the
        // 500 ms status poll caps the resolution.
        var timer = Stopwatch.StartNew();
        long? firstUsableMs = null;

        // One at a time: opening the whole set first would cost the same total time but make every
        // plugin wait on the slowest before any could be indexed, and bury each open failure.
        var pending = new Queue<RegisteredPlugin>(arriving);
        // Read in the first landing, for every landing: a queued plugin's rows change only when it lands.
        var indexed = new Lazy<Store.IndexedStamps>(() => store.IndexedStamps(arriving.Select(plugin => plugin.Key)));
        while (pending.Count > 0)
        {
            if (LandArrivals(scope, snapshot, pending, indexed, token) > 0) firstUsableMs ??= timer.ElapsedMilliseconds;
            LandNamedBetween(scope, key => pending.Any(plugin => PluginAddress.Comparer.Equals(plugin.Key, key)));
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

    private void ReadEachLandingBetween(
        OpenScope scope, IReadOnlyList<RegisteredPlugin> plugins, Func<PluginAddress, bool> stillToLand, Action<RegisteredPlugin> read,
        CancellationToken token)
    {
        foreach (var plugin in plugins)
        {
            token.ThrowIfCancellationRequested();
            read(plugin);
            LandNamedBetween(scope, stillToLand);
        }
    }

    // A plugin whose folder gained or lost its repository or its tree since it was indexed. Nothing here
    // has compared the two truths, so the plugin is re-derived whole from the one its folder now offers.
    private void ReDerive(OpenScope scope, RegisteredPlugin plugin, CancellationToken token)
    {
        if (scope.Held.Find(plugin.Key) is not { } metadata) return;
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "{Plugin} ({Origin}) now reads as {Truth}; re-deriving it", plugin.Name, plugin.Origin,
                scope.Projector.TruthOf(plugin));
        }
        ReadOne(scope, plugin, state => IndexOnePlugin(scope, metadata, state, token), token);
    }

    // plugins.md, A row, Plugin: one plugin that cannot be read is that row's "Failed to read", never
    // the whole index's failure.
    private void ReadOne(OpenScope scope, RegisteredPlugin plugin, Func<ReadState, ReadOutcome> read, CancellationToken token)
    {
        var started = _timeProvider.GetUtcNow();
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
        finally
        {
            WarnIfSlow("Reading", plugin.Key, started);
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
    private bool WarmRegister(OpenScope scope, PluginMetadata plugin, ReadState state, Store.IndexedStamps indexed, CancellationToken token)
    {
        scope.Store.Register(plugin);

        // A binary was already hashed against its stored claim when the record index file opened
        // (Store.ValidateAgainstDisk), so a second hash of every binary here would pay that whole cost
        // twice for no new answer.
        var truth = scope.Projector.TruthOf(plugin.Registered);
        if (truth != DerivedFrom.SourceTree) return indexed.DerivationOf(plugin.Key) is var derivedFrom && derivedFrom == truth
            && StringsStillRead(scope.LoadOrder, plugin.Registered, derivedFrom, scope.Store.IndexedStringsRead(plugin.Key));

        try
        {
            var report = scope.Projector.Validate(plugin.Registered, state, indexed);
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
        RememberFileFailedAt(scope, key);
        if (scope.Held.SetFailure(key, reason, diagnosis)) PublishStatus();
    }

    private void FailRead(OpenScope scope, PluginAddress key, LoadFailure failure) =>
        FailRead(scope, key, ReadFailure(failure.Reason, scope.Store.DerivationOf(key)), failure.IsDiagnosis ? failure.Reason : null);

    // A landing reapplies the record filter, so arrivals indexed before, and plugins a check validates, land together. A
    // plugin the record index has not read lands alone, so no plugin waits on its read to be listed.
    private static readonly TimeSpan LandTogetherFor = TimeSpan.FromSeconds(0.5);

    private int LandArrivals(
        OpenScope scope, LoadOrderSnapshot snapshot, Queue<RegisteredPlugin> pending, Lazy<Store.IndexedStamps> arrivals, CancellationToken token)
    {
        var landed = new List<PluginMetadata>();
        var until = _timeProvider.GetUtcNow() + LandTogetherFor;
        try
        {
            scope.Store.Commit(projection =>
            {
                var indexed = arrivals.Value;
                var first = true;
                while (pending.TryPeek(out var plugin)
                    && (first || indexed.FileOf(plugin.Key) is not null && _timeProvider.GetUtcNow() < until))
                {
                    token.ThrowIfCancellationRequested();
                    first = false;
                    pending.Dequeue();
                    ReadOne(scope, plugin, state =>
                    {
                        if (!scope.Held.Open(plugin, Registration.In(snapshot, plugin.Key), snapshot).Holds(out var metadata, out var failure))
                            return ReadOutcome.Failed(failure);
                        var outcome = RegisterWarmOrIndex(scope, metadata, state, indexed, token);
                        if (outcome.Failure is null)
                        {
                            landed.Add(metadata);
                            projection.PluginChanged(metadata.Key);
                        }
                        return outcome;
                    }, token);
                }
            });
        }
        finally
        {
            ListLanded(landed);
        }
        return landed.Count;
    }

    // ADR-0010: a plugin the store has seen, still matching the disk, is registered, not
    // indexed; ADR-0003 validates a compiled plugin by content on that same warm path.
    private ReadOutcome RegisterWarmOrIndex(OpenScope scope, PluginMetadata plugin, ReadState state, Store.IndexedStamps indexed, CancellationToken token)
    {
        if (indexed.FileOf(plugin.Key) is not null && WarmRegister(scope, plugin, state, indexed, token))
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation(
                    "Registering {Plugin}, already indexed and unchanged on disk", plugin.Name);
            }
            return ReadOutcome.Read;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Indexing {Plugin}", plugin.Name);
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

    // One commit for the whole plugin, whichever door it came through.
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
        if (!_adapter.CountRecords(modPath, scope.LoadOrder).Holds(out var counted, out var countFailure))
        {
            _logger.LogWarning(countFailure.Error, "Could not read {Plugin} ({Origin}): {Reason}", plugin.Name, plugin.Origin, countFailure.Reason);
            return ReadOutcome.Failed(countFailure);
        }
        if (counted.Unreachable is { } stoppedWalk)
        {
            // The ingest walks the same records per type and reports the one it could not finish,
            // so this only keeps a readout from becoming a refusal to read the plugin.
            _logger.LogWarning(stoppedWalk.Error,
                "Could not walk all of {Plugin}'s records for its count; holding it to the {Count} that were reachable: {Reason}",
                plugin.Name, counted.Count, stoppedWalk.Reason);
        }
        if (!_adapter.OpenDocuments(modPath, scope.LoadOrder, scope.Store.Schemas, plugin.Strings).Holds(out var opened, out var failure))
        {
            _logger.LogWarning(failure.Error, "Could not read {Plugin} ({Origin}): {Reason}", plugin.Name, plugin.Origin, failure.Reason);
            return ReadOutcome.Failed(failure);
        }

        using var documents = opened;
        if (scope.Store.IndexBinary(documents, plugin, plugin.Path, derivedFrom, stringsRead, counted.Count, _disposal.Token) is not { } refused) return ReadOutcome.Read;
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

    // ADR-0029: the plugins validated within a landing's time land together until something is named, which then lands
    // between, moving the stamps. A plugin not held failed to open, and the reconcile opens it again once its bytes change.
    private void ValidateIndex(CancellationToken token)
    {
        var scope = RequireScope();
        var plugins = scope.Held.Plugins;
        Store.IndexedStamps? indexed = null;
        var at = 0;
        do
        {
            var until = _timeProvider.GetUtcNow() + LandTogetherFor;
            var landed = new List<PluginMetadata>();
            try
            {
                scope.Store.Commit(_ =>
                {
                    indexed ??= scope.Store.IndexedStamps(plugins.Skip(at).Select(held => held.Key).Where(key => !scope.Projector.Matched(key)));
                    for (var first = true; at < plugins.Count && (first || (_timeProvider.GetUtcNow() < until && !NamedWaits())); first = false)
                    {
                        token.ThrowIfCancellationRequested();
                        if (scope.Held.Find(plugins[at++].Key) is { } plugin && ValidateOne(scope, plugin, indexed, token)) landed.Add(plugin);
                    }
                });
            }
            finally
            {
                ListLanded(landed);
            }
            if (LandNamedBetween(scope, _ => false)) indexed = null;
        }
        while (at < plugins.Count);
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
                var indexed = scope.Store.IndexedStamps(plugins.Select(plugin => plugin.Key).Where(key => !scope.Projector.Matched(key)));
                foreach (var plugin in plugins)
                {
                    token.ThrowIfCancellationRequested();
                    if (ValidateOne(scope, plugin, indexed, token)) landed.Add(plugin);
                }
            });
        }
        finally
        {
            ListLanded(landed);
        }
    }

    // Listed only once the commit that read it has landed: Status promises a plugin listed here is
    // wholly queryable, the filter's matches in it included.
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
    private bool ValidateOne(OpenScope scope, PluginMetadata plugin, Store.IndexedStamps indexed, CancellationToken token)
    {
        var (held, store) = (scope.Held, scope.Store);
        var key = plugin.Key;
        var holdsTree = scope.Projector.TruthOf(plugin.Registered) == DerivedFrom.SourceTree;
        var started = _timeProvider.GetUtcNow();
        try
        {
            if (!holdsTree && !_adapter.Exists(plugin.Path))
            {
                if (indexed.FileOf(key) is not null) store.Unindex(key);
                return false;
            }

            if (holdsTree) plugin = ReopenHeader(scope, plugin);

            // Rows a failed read left say nothing of what the plugin now reads from.
            if (held.IsHeldWithAFailure(key) || scope.Failed.Holds(key))
            {
                return !scope.Failed.StillFailing(plugin.Registered) && ReindexHeldPlugin(scope, plugin);
            }

            var readWhole = false;
            scope.Failed.Read(plugin.Registered, state =>
            {
                readWhole = MustReadWhole(scope, plugin, holdsTree, state, indexed, token);
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
        finally
        {
            WarnIfSlow("Checking", key, started);
        }
    }

    private static readonly TimeSpan SlowForOnePlugin = TimeSpan.FromSeconds(10);

    private void WarnIfSlow(string operation, PluginAddress key, DateTimeOffset started)
    {
        var took = _timeProvider.GetUtcNow() - started;
        if (took > SlowForOnePlugin)
            _logger.LogWarning("{Operation} {Plugin} ({Origin}) took {Seconds} s", operation, key.Name, key.Origin, (int)took.TotalSeconds);
    }

    // When the rows cannot be brought true here. A tree that cannot be read is read whole, which reads
    // the binary in its place and names what stopped it.
    private bool MustReadWhole(OpenScope scope, PluginMetadata plugin, bool holdsTree, ReadState state, Store.IndexedStamps indexed, CancellationToken token)
    {
        var key = plugin.Key;
        try
        {
            var report = scope.Projector.Validate(plugin.Registered, state, indexed);
            foreach (var failure in report.Failures)
                _logger.LogWarning("Reconciling {Plugin}: {Failure}", key.Name, failure);

            // Gained records are refreshed by key so the rows that moved are named.
            if (report.NeedsRebuild && report.ChangedKeys.Count > 0 && plugin.Provider is PluginProvider.FromMod)
            {
                if (scope.Projector.RefreshByKeys(plugin.Registered, report.ChangedKeys) is not { } stopped) return false;
                _logger.LogWarning("Reconciling {Plugin}: {Failure}; reading it whole", key.Name, stopped.Reason);
                return true;
            }
            // A non-compiled plugin's rows went with its file, and the file is back.
            return report.NeedsRebuild || (!holdsTree && indexed.FileOf(key) is null);
        }
        catch (Exception ex) when (RetriedByAWholeRead(ex, token))
        {
            _logger.LogWarning(ex, "Reconciling {Plugin}: its rows cannot be validated, so it is read whole", key.Name);
            return true;
        }
    }

    // A tree's rows say nothing of its compiled file's header. A file gone or unreadable leaves the header last read,
    // and the next change to the file reads it again.
    private PluginMetadata ReopenHeader(OpenScope scope, PluginMetadata plugin)
    {
        if (!_adapter.Exists(plugin.Path)) return plugin;
        if (!scope.Held.Reopen(plugin.Registered, Registration.In(scope.LoadOrder, plugin.Key), scope.LoadOrder).Holds(out var reopened, out _)
            || reopened.Content == plugin.Content) return plugin;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("{Plugin} ({Origin}): header changed, masters now [{Masters}]", plugin.Name, plugin.Origin, string.Join(", ", reopened.Masters));
        }
        scope.Store.Commit(projection => projection.PluginChanged(plugin.Key));
        return reopened;
    }

    // editor.md, States, story 6: the rows stay the last good read, and say why.
    private static string ValidationFailure(bool holdsTree, string reason) =>
        $"Could not validate this plugin's {(holdsTree ? "source tree" : "binary")} ({reason}). Still showing " +
        "what was last read from it.";

    // A check of the disk that changed the status reads Reconciling until the plugins are validated. The message
    // when validation failed outright, which becomes status data.
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
            // Busy, not broken: validation is idempotent, and the next check of the disk validates again.
            _logger.LogWarning(ex, "Could not validate the record index while another write held it; the next check of the disk validates it");
            busy = true;
            return null;
        }
        catch (Exception ex) when (!CancelledBy(ex, token))
        {
            // Every type, out of memory included: the failure becomes status data (plugins.md,
            // States, story 6), and the next check of the disk tries again.
            _logger.LogError(ex, "Validating the record index failed unexpectedly");
            return FailureAfterReopening(ex);
        }
    }

    // ADR-0007: the read a first index runs, so a re-read gives the same rows. A failed read is recorded and
    // rethrown, so it is not read again until that changes. A binary is reopened for its header.
    private bool ReindexHeldPlugin(OpenScope scope, PluginMetadata plugin)
    {
        var key = plugin.Key;
        var readsBinary = scope.Projector.TruthOf(plugin.Registered) != DerivedFrom.SourceTree;
        ReadOutcome outcome;
        try
        {
            outcome = scope.Store.Commit(_ => scope.Failed.Read(plugin.Registered, state =>
            {
                if (!readsBinary) return ReadWhole(scope, plugin, state);
                return scope.Held.Open(plugin.Registered, Registration.In(scope.LoadOrder, key), scope.LoadOrder).Holds(out var reopened, out var failure)
                    ? ReadWhole(scope, reopened, state)
                    : ReadOutcome.Failed(failure);
            }));
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
        var before = scope.Store.EffectiveContentHashes(plugin.Key);
        var read = IndexOnePlugin(scope, plugin, state, CancellationToken.None);
        if (read.Failure is null) projection.PluginReread(plugin.Key, before);
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
            lock (_lock) _closedForRebuild = _scope is null ? null : (_plannedCount, _activeCount);
            if (!Close())
            {
                lock (_lock) _closedForRebuild = null;
                AskReconcile();
                return false;
            }
            try { heldElsewhere = whileClosed(new ClosedStore(_storeFactory, handedOut)); }
            catch (IndexFaultException ex) { failure = ex.Message; }
            var refusal = heldElsewhere;
            var failed = failure;
            Swap(standing => standing with { HeldElsewhere = refusal, Failure = failed });
            if (refusal is not null || failed is not null) lock (_lock) _closedForRebuild = null;
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
        _source.ChangeSignalled += OnChange;
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
        _source.ChangeSignalled -= OnChange;

        lock (_turns)
        {
            _disposed = true;
            Answer([.. _namedHands.Select(hand => hand.Held), .. _checkHands], Closed);
        }

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
        return detached;
    }
}
