using System.Collections.Concurrent;

namespace MEditService.Http.Endpoints;

/// <summary>Each modlist gesture running, by the id its client gave it. A cancel can arrive before its gesture does,
/// and still stops it.</summary>
internal sealed class ModlistGestureCancels
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _byGesture = new(StringComparer.Ordinal);

    public void Cancel(string gesture) => SourceOf(gesture).Cancel();

    /// <summary>The token a gesture runs under: cancelled by its client's cancel, or by the request's abort.</summary>
    public Running Run(string? gesture, CancellationToken aborted) => new(this, gesture, aborted);

    private CancellationTokenSource SourceOf(string gesture) => _byGesture.GetOrAdd(gesture, _ => new CancellationTokenSource());

    internal sealed class Running : IDisposable
    {
        private readonly ModlistGestureCancels _cancels;
        private readonly string? _gesture;
        private readonly CancellationTokenSource? _linked;

        public Running(ModlistGestureCancels cancels, string? gesture, CancellationToken aborted)
        {
            _cancels = cancels;
            _gesture = gesture;
            _linked = gesture is null ? null : CancellationTokenSource.CreateLinkedTokenSource(cancels.SourceOf(gesture).Token, aborted);
            Token = _linked?.Token ?? aborted;
        }

        public CancellationToken Token { get; }

        public void Dispose()
        {
            _linked?.Dispose();
            if (_gesture is not null && _cancels._byGesture.TryRemove(_gesture, out var source)) source.Dispose();
        }
    }
}
