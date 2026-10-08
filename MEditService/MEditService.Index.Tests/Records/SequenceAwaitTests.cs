using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

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
    public async Task AwaitSequence_AlreadyReached_AnswersTrue_WithTheClockStill()
    {
        var landed = _index.Sequence;

        var pending = _index.Records.AwaitSequence(landed, TimeSpan.FromDays(1));

        Assert.True(await Waits.CompletesWithin(pending, Generous));
        Assert.True((await pending).Reached);
    }

    private static readonly TimeSpan DayLongTimeoutSoAStopwatchAwaitWouldStillBePending = TimeSpan.FromDays(1);

    [Fact]
    public async Task AwaitSequence_NotReached_AnswersNotYet_OnceTheClockPassesTheTimeout()
    {
        var pending = _index.Records.AwaitSequence(_index.Sequence + 1, DayLongTimeoutSoAStopwatchAwaitWouldStillBePending);

        _clock.SetUtcNow(Start + TimeSpan.FromDays(2));

        Assert.True(await Waits.CompletesWithin(pending, Generous));
        Assert.False((await pending).Reached);
    }

    [Fact]
    public async Task AwaitSequence_LandingWhileWaiting_AnswersTrue_WithTheClockAdvancedOnlyToWakeThePoll()
    {
        var pending = _index.Records.AwaitSequence(_index.Sequence + 1, DayLongTimeoutSoAStopwatchAwaitWouldStillBePending);

        var path = _fixture.Plugins.Single().Path;
        PluginBinaries.Touch(path);
        _index.NextSnapshot();

        _clock.Advance(TimeSpan.FromMilliseconds(50));

        Assert.True(await Waits.CompletesWithin(pending, Generous));
        Assert.True((await pending).Reached);
    }
}
