using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class SequenceAwaitTests : IDisposable
{
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private readonly FakeTimeProvider _clock = new(Start);
    private readonly LoadOrderHolder _holder = new();
    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("sequence-await")
        .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
        .Build();
    private readonly OpenedIndex _index;

    public SequenceAwaitTests()
    {
        _index = Indexes.Open(_holder, timeProvider: _clock);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task ASequenceAlreadyReached_IsAnsweredReached_WithTheClockStill()
    {
        var landed = _index.Sequence;

        var pending = _index.Queries.AwaitSequence(landed, TimeSpan.FromDays(1));

        Assert.True((await pending.WaitAsync(Generous)).Reached);
    }

    private static readonly TimeSpan DayLongTimeoutSoAStopwatchAwaitWouldStillBePending = TimeSpan.FromDays(1);

    [Fact]
    public async Task ASequenceNotReached_IsAnsweredNotYet_OnceTheClockPassesTheTimeout()
    {
        var pending = _index.Queries.AwaitSequence(_index.Sequence + 1, DayLongTimeoutSoAStopwatchAwaitWouldStillBePending);

        _clock.SetUtcNow(Start + TimeSpan.FromDays(2));

        Assert.False((await pending.WaitAsync(Generous)).Reached);
    }

    [Fact]
    public async Task ASequenceLandingWhileAwaited_IsAnsweredReached_WithTheClockAdvancedOnlyToWakeThePoll()
    {
        var pending = _index.Queries.AwaitSequence(_index.Sequence + 1, DayLongTimeoutSoAStopwatchAwaitWouldStillBePending);

        var path = _fixture.Plugins.Single().Path;
        PluginBinaries.Touch(path);
        _index.NextCheck();

        _clock.Advance(TimeSpan.FromMilliseconds(50));

        Assert.True((await pending.WaitAsync(Generous)).Reached);
    }
}
