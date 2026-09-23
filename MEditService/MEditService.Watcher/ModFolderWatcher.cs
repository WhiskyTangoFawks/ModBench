using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Watcher;

/// <summary>The Mod watcher of the target architecture: the one listener to the load-order change,
/// with one watch per mod folder it names. Nothing sends it a message; it tells the Index and
/// Commands and announces nothing.</summary>
public sealed class ModFolderWatcher : IDisposable
{
    private readonly LoadOrderHolder _holder;
    private readonly WatchSet _watches;
    private readonly WatcherSinks _sinks;
    private readonly OverflowValidation _overflow;
    private readonly ILogger _logger;
    private readonly Action<LoadOrderSnapshot, long> _onChanged;
    private readonly object _lifecycle = new();
    private int _inFlight;
    private bool _disposed;

    /// <summary>The 300ms default collapses several events into one settle; the 2s default bounds a
    /// batch the stream never lets go quiet. Both windows run on the injected clock.</summary>
    public ModFolderWatcher(
        LoadOrderHolder holder,
        IRefreshIndex index,
        TrackedModSettled settled,
        ILogger logger,
        TimeSpan? quiet = null,
        TimeSpan? maxWindow = null,
        TimeProvider? timeProvider = null)
    {
        _holder = holder;
        _logger = logger;
        _sinks = new WatcherSinks(index, settled, logger);
        _overflow = new OverflowValidation(_sinks, logger);
        _watches = new WatchSet(
            quiet ?? TimeSpan.FromMilliseconds(300),
            maxWindow ?? TimeSpan.FromSeconds(2),
            timeProvider ?? TimeProvider.System,
            OnSettle,
            OnOverflow);
        _onChanged = OnChanged;
    }

    /// <summary>Starts listening to the load-order change (ADR-0013 invariant 1). Each change
    /// re-arms, settles every tracked mod and reconciles, off the writer's thread.</summary>
    public void Subscribe() => _holder.Changed += _onChanged;

    // A dedicated thread, not the shared pool: the disk work here should not queue behind whatever
    // else the pool is busy with.
    private void OnChanged(LoadOrderSnapshot snapshot, long version)
    {
        if (!TryEnter()) return;
        Task.Factory.StartNew(
            () => ArmSettleAndReconcile(snapshot, version),
            CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    // Arming comes first, so no stale watch settles after it; the reconcile (ADR-0013 invariant
    // 1) then goes on its own thread beside the settles and waits on no git status per mod.
    private void ArmSettleAndReconcile(LoadOrderSnapshot snapshot, long version)
    {
        try
        {
            if (Armed(snapshot, version) is not { } tracked) return;

            // Outside the in-flight scope: the Index owns its own cancellation on disposal, and a
            // disposed watcher speaks for no snapshot.
            if (!IsDisposed)
            {
                Task.Factory.StartNew(
                    () => _sinks.Reconcile(snapshot, version),
                    CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            }

            foreach (var mod in tracked) RaiseSafely(() => SettleAtLoad(snapshot, mod));
        }
        finally
        {
            Exit();
        }
    }

    // Null when a newer change was armed already; empty when arming failed, which the log carries,
    // since no status of its own carries an unknown failure as data (unlike the Index).
    private IReadOnlyList<TrackedMod>? Armed(LoadOrderSnapshot snapshot, long version)
    {
        try
        {
            return _watches.Arm(snapshot, version);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogError(ex, "Re-arming the watcher after a load order change failed unexpectedly");
            return [];
        }
    }

    // One read of each tracked binary serves both the readability probe and the classification.
    // An unreadable binary gets the repair offer and no classification, since a partial set would
    // classify the rest as the whole mod.
    private void SettleAtLoad(LoadOrderSnapshot order, TrackedMod mod)
    {
        var observed = new List<(string PluginName, byte[] ObservedBytes)>();
        var unreadable = new List<string>();
        foreach (var copy in mod.Copies)
        {
            try
            {
                observed.Add((copy.Name, File.ReadAllBytes(copy.Path)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Could not read {Plugin} for the external-change load-time check", copy.Name);
                unreadable.Add(copy.Name);
            }
        }

        if (unreadable.Count > 0)
            foreach (var name in unreadable) _sinks.OfferRepairForUnreadable(order, mod.ModFolder, name);
        else
            _sinks.SettleAtLoad(order, mod.ModFolder, observed);

        if (_logger.IsEnabled(LogLevel.Debug)) _logger.LogDebug("Load-time settle of {ModFolder} done", mod.ModFolder);
    }

    // Fired by either of the mod's own timers. A tracked mod's binaries and other files are
    // Commands' question; an untracked mod's binaries are the Index's own comparison.
    private void OnSettle(ModWatch mod)
    {
        if (!TryEnter()) return;
        _ = InFlight(() => SettleAsync(mod));
    }

    private async Task SettleAsync(ModWatch mod)
    {
        var window = mod.Close();
        if (window.IsEmpty) return;

        if (window.Batch.Count > 0) RaiseSafely(() => _sinks.ProjectSourceBatch(window.Batch));

        if (SourceRepository.IsTracked(mod.ModFolder))
        {
            if (window.ModTouched || window.Binaries.Count > 0)
                RaiseSafely(() => _sinks.Settle(_holder.Current, mod.ModFolder));
        }
        else
        {
            foreach (var binary in window.Binaries)
                await _sinks.RefreshBinary(binary.Key, binary.Path).ConfigureAwait(false);
        }

        if (_logger.IsEnabled(LogLevel.Debug)) _logger.LogDebug("Live settle of {ModFolder} done", mod.ModFolder);
    }

    // An operating-system overflow dropped events, so nothing this mod's watch saw can be trusted.
    // A vanished root raises the same event, with nothing left to watch.
    private void OnOverflow(ModWatch mod)
    {
        if (!TryEnter()) return;
        _ = InFlight(() =>
        {
            if (!mod.FolderExists)
            {
                _watches.Drop(mod);
                return Task.CompletedTask;
            }

            mod.MarkEverythingTouched();
            _overflow.Validate(mod.RegisteredKeys);
            return Task.CompletedTask;
        });
    }

    // A callback already past the in-flight gate: it always exits the gate, whatever it did.
    private async Task InFlight(Func<Task> callback)
    {
        try
        {
            await RaiseSafely(callback).ConfigureAwait(false);
        }
        finally
        {
            Exit();
        }
    }

    // Completed before it returns, since nothing in a synchronous action awaits.
    private void RaiseSafely(Action action) =>
        _ = RaiseSafely(() =>
        {
            action();
            return Task.CompletedTask;
        });

    // Runs on the FileSystemWatcher's own thread or a timer callback, with no caller to catch
    // anything: the one catch every callback shares.
    private async Task RaiseSafely(Func<Task> action)
    {
        try
        {
            await action().ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogError(ex, "A watcher callback failed unexpectedly");
        }
    }

    private bool IsDisposed
    {
        get { lock (_lifecycle) return _disposed; }
    }

    private bool TryEnter()
    {
        lock (_lifecycle)
        {
            if (_disposed) return false;
            _inFlight++;
            return true;
        }
    }

    private void Exit()
    {
        lock (_lifecycle)
        {
            _inFlight--;
            if (_inFlight == 0) Monitor.PulseAll(_lifecycle);
        }
    }

    /// <summary>Stops listening, stops every settle, and returns only once every sink already in
    /// flight has finished: a caller that then removes the folders finds no git process still
    /// writing into them.</summary>
    public void Dispose()
    {
        _holder.Changed -= _onChanged;
        lock (_lifecycle) _disposed = true;
        _watches.Dispose();
        lock (_lifecycle)
        {
            while (_inFlight > 0) Monitor.Wait(_lifecycle);
        }
    }
}
