using Microsoft.Extensions.Time.Testing;

namespace MEditService.Watcher.Tests.TestSupport;

/// <summary>The clock the watcher's windows run on, counting what its watches took in: a watch
/// extends its quiet window once per path observed, so an arming of that window is one file event
/// the subject already holds.</summary>
internal sealed class ObservingClock : TimeProvider
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.UnixEpoch);
    private readonly TimeSpan _quiet;
    private int _observations;

    /// <summary>The quiet window is what tells the two timers apart, so neither may be armed for
    /// the other's span.</summary>
    internal ObservingClock(TimeSpan quiet, TimeSpan maxWindow)
    {
        if (quiet == maxWindow)
            throw new ArgumentException("The two windows must differ, or an arming names neither.", nameof(maxWindow));
        _quiet = quiet;
    }

    /// <summary>How many paths the watcher's watches have observed since this clock was made.</summary>
    internal int Observations => Volatile.Read(ref _observations);

    internal void Advance(TimeSpan by) => _clock.Advance(by);

    public override DateTimeOffset GetUtcNow() => _clock.GetUtcNow();

    public override long GetTimestamp() => _clock.GetTimestamp();

    public override long TimestampFrequency => _clock.TimestampFrequency;

    public override TimeZoneInfo LocalTimeZone => _clock.LocalTimeZone;

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
        new CountingTimer(_clock.CreateTimer(callback, state, dueTime, period), this);

    private void Observed() => Interlocked.Increment(ref _observations);

    private sealed class CountingTimer(ITimer timer, ObservingClock clock) : ITimer
    {
        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            var armed = timer.Change(dueTime, period);
            if (armed && dueTime == clock._quiet) clock.Observed();
            return armed;
        }

        public void Dispose() => timer.Dispose();

        public ValueTask DisposeAsync() => timer.DisposeAsync();
    }
}
