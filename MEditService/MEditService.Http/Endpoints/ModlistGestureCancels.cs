namespace MEditService.Http.Endpoints;

/// <summary>Each modlist gesture running, by the id its client gave it. Only a running gesture is held, so a cancel
/// for any other id finds nothing.</summary>
internal sealed class ModlistGestureCancels
{
    private readonly Dictionary<string, CancellationTokenSource> _running = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    /// <summary>False when no gesture runs by that id.</summary>
    public bool Cancel(string gesture)
    {
        lock (_gate)
        {
            if (!_running.TryGetValue(gesture, out var source)) return false;
            source.Cancel();
            return true;
        }
    }

    /// <summary>The token a gesture runs under: cancelled by its client's cancel, or by the request's abort.</summary>
    public Running Run(string? gesture, CancellationToken aborted) => new(this, gesture, aborted);

    internal sealed class Running : IDisposable
    {
        private readonly ModlistGestureCancels _cancels;
        private readonly string? _gesture;
        private readonly CancellationTokenSource _source;

        public Running(ModlistGestureCancels cancels, string? gesture, CancellationToken aborted)
        {
            _cancels = cancels;
            _gesture = gesture;
            _source = CancellationTokenSource.CreateLinkedTokenSource(aborted);
            if (gesture is null) return;
            lock (cancels._gate) cancels._running[gesture] = _source;
        }

        public CancellationToken Token => _source.Token;

        public void Dispose()
        {
            if (_gesture is not null)
            {
                lock (_cancels._gate)
                {
                    if (_cancels._running.TryGetValue(_gesture, out var held) && held == _source) _cancels._running.Remove(_gesture);
                }
            }
            _source.Dispose();
        }
    }
}
