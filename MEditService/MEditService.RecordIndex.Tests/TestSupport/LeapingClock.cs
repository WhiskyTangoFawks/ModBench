namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Real time until told to leap. Then every reading is a day past the last, so any wait the
/// record index bounds on it has run out.</summary>
internal sealed class LeapingClock : TimeProvider
{
    private long _leaps;
    private volatile bool _leaping;

    public void StartLeaping() => _leaping = true;

    public void StopLeaping() => _leaping = false;

    public override DateTimeOffset GetUtcNow() =>
        base.GetUtcNow() + TimeSpan.FromDays(_leaping ? Interlocked.Increment(ref _leaps) : Interlocked.Read(ref _leaps));
}
