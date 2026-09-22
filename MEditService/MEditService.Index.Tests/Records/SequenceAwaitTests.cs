using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

// The sequence await measures its timeout on the injected clock, so "not yet" is a clock answer
// and never a wall-clock one: a test moves the clock, and nothing here waits real time out.
public sealed class SequenceAwaitTests : IDisposable
{
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private readonly FakeTimeProvider _clock = new(Start);
    private readonly LoadOrderHolder _holder = new();
    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("sequence-await")
        .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
        .Build();
    private readonly IndexProjector _index;

    public SequenceAwaitTests()
    {
        _index = new IndexProjector(_holder, TestAdapters.Mutagen(), SharedSchemaReflector.Instance, timeProvider: _clock);
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

        var pending = _index.AwaitSequenceAsync(landed, TimeSpan.FromDays(1));

        Assert.True(await Waits.CompletesWithin(pending, Generous));
        Assert.True(await pending);
    }

    // The rival this pins: a stopwatch. With a day's timeout, a wall-clock await would still be
    // pending long after the fake clock passed the deadline, and the bound below would fail it.
    [Fact]
    public async Task AwaitSequence_NotReached_AnswersNotYet_OnceTheClockPassesTheTimeout()
    {
        var pending = _index.AwaitSequenceAsync(_index.Sequence + 1, TimeSpan.FromDays(1));

        _clock.SetUtcNow(Start + TimeSpan.FromDays(2));

        Assert.True(await Waits.CompletesWithin(pending, Generous));
        Assert.False(await pending);
    }

    [Fact]
    public async Task AwaitSequence_LandingWhileWaiting_AnswersTrue_WithTheClockAdvancedOnlyToWakeThePoll()
    {
        var pending = _index.AwaitSequenceAsync(_index.Sequence + 1, TimeSpan.FromDays(1));

        var path = _fixture.Plugins.Single().Path;
        PluginBinaries.Touch(path);
        Assert.True(await _index.RefreshBinary(_fixture.Plugins.Single().KeyOf(), path));

        // The landing already happened above; this wakes the poll due on the fake clock's own
        // timer to re-check, never touching the day-long deadline that answers "not yet".
        _clock.Advance(TimeSpan.FromMilliseconds(50));

        Assert.True(await Waits.CompletesWithin(pending, Generous));
        Assert.True(await pending);
    }
}
