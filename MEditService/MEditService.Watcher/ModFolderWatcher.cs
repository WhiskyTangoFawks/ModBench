using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
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
    private readonly WholePluginValidation _validation;
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
        _validation = new WholePluginValidation(_sinks, logger);
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
            if (Armed(snapshot, version) is not { } toSettle) return;

            // Outside the in-flight scope: the Index owns its own cancellation on disposal, and a
            // disposed watcher speaks for no snapshot.
            if (!IsDisposed)
            {
                Task.Factory.StartNew(
                    () => _sinks.Reconcile(snapshot, version),
                    CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            }

            foreach (var modFolder in toSettle) RaiseSafely(() => SettleAtLoad(snapshot, modFolder));
        }
        finally
        {
            Exit();
        }
    }

    // Null when a newer change was armed already; empty when arming failed, which the log carries,
    // since no status of its own carries an unknown failure as data (unlike the Index).
    private IReadOnlyList<string>? Armed(LoadOrderSnapshot snapshot, long version)
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

    private void SettleAtLoad(LoadOrderSnapshot order, string modFolder)
    {
        _sinks.Settle(order, modFolder);
        if (_logger.IsEnabled(LogLevel.Debug)) _logger.LogDebug("Load-time settle of {ModFolder} done", modFolder);
    }

    // Fired by either of the mod's own timers. A tracked mod's binaries are Commands' comparison; an
    // untracked mod's binaries are the Index's own.
    private void OnSettle(ModWatch mod)
    {
        if (!TryEnter()) return;
        _ = InFlight(() => SettleAsync(mod));
    }

    private async Task SettleAsync(ModWatch mod)
    {
        var window = mod.Close();
        if (window.IsEmpty) return;

        // Once per window, however many paths it holds, and first, so what follows lands in the
        // index the retry opened.
        RaiseSafely(_sinks.RetryFailedReconcile);

        // A move of tracked-ness moves which truth every plugin of the mod reads, so each is
        // re-derived whole, which covers whatever the batch named.
        var (tracked, moved) = mod.Trackedness();
        if (moved) _validation.Validate(mod.RegisteredKeys, "its repository coming or going");
        else if (window.Batch.Count > 0) RaiseSafely(() => _sinks.ProjectSourceBatch(window.Batch));

        if (moved || (tracked && (window.ModTouched || window.Binaries.Count > 0)))
            RaiseSafely(() => _sinks.Settle(_holder.Current, mod.ModFolder));

        if (!tracked)
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
            _validation.Validate(mod.RegisteredKeys, "a watch overflow");
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
