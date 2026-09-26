namespace MEditService.Http.Tests.TestSupport;

/// <summary>Real time for every reader, wrapping only the watch's quiet-window timer: counts each
/// arming, and can fire the one most recently armed right now instead of waiting out its delay.</summary>
public sealed class ObservingClock : TimeProvider
{
    private readonly TimeSpan _quiet;
    private ITimer? _lastArmedQuietTimer;
    private int _observations;

    public ObservingClock(TimeSpan quiet)
    {
        _quiet = quiet;
    }

    /// <summary>How many times a watch has armed its quiet window since this clock was made.</summary>
    public int Observations => Volatile.Read(ref _observations);

    /// <summary>Fires the most recently armed quiet window now, in place of its real delay.</summary>
    public void FireArmedQuietWindowNow() =>
        (Volatile.Read(ref _lastArmedQuietTimer) ?? throw new InvalidOperationException(
            "No quiet window has armed yet; wait for Observations to advance first."))
        .Change(TimeSpan.Zero, Timeout.InfiniteTimeSpan);

    public override DateTimeOffset GetUtcNow() => System.GetUtcNow();

    public override long GetTimestamp() => System.GetTimestamp();

    public override long TimestampFrequency => System.TimestampFrequency;

    public override TimeZoneInfo LocalTimeZone => System.LocalTimeZone;

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
        new CountingTimer(System.CreateTimer(callback, state, dueTime, period), this);

    private void Observed(ITimer timer)
    {
        Volatile.Write(ref _lastArmedQuietTimer, timer);
        Interlocked.Increment(ref _observations);
    }

    private sealed class CountingTimer(ITimer timer, ObservingClock clock) : ITimer
    {
        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            var armed = timer.Change(dueTime, period);
            if (armed && dueTime == clock._quiet) clock.Observed(timer);
            return armed;
        }

        public void Dispose() => timer.Dispose();

        public ValueTask DisposeAsync() => timer.DisposeAsync();
    }
}
