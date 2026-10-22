using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReadOutlivesTheDrainTests : IDisposable
{
    private const string Plugin = "Drained.esp";

    private const string SecondsLongReadOnOneCore =
        "WITH RECURSIVE steps(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM steps WHERE n < 60000) SELECT count(*) AS n FROM steps";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("read-outlives-drain")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew("DrainedNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly LeapingClock _clock = new();
    private readonly OpenedIndex _index;

    public ReadOutlivesTheDrainTests()
    {
        _index = Indexes.Open(_holder, new MutagenPluginAdapter(TimeProvider.System), timeProvider: _clock);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        _index.Queries.SelectRows("SELECT 1 AS n").Value();
    }

    public void Dispose()
    {
        _clock.Stop();
        _index.Dispose();
        _fixture.Dispose();
    }

    private PluginAddress Key => _fixture.Plugins.Single().KeyOf();

    private async Task<Task<Answer<SelectedRows, IndexRefused>>> AReadOutlivingEveryDrain()
    {
        var read = Task.Run(() => _index.Queries.SelectRows(SecondsLongReadOnOneCore));
        await Task.Delay(TimeSpan.FromMilliseconds(500));
        Assert.False(read.IsCompleted, "The slow read ended before the drain it is meant to outlive.");
        _clock.Leap();
        return read;
    }

    private async Task ReadEnds(Task<Answer<SelectedRows, IndexRefused>> read)
    {
        _clock.Stop();
        Assert.True((await read.WaitAsync(Waits.Patience)).Holds(out _, out _), "The read opened only once its store was closed to reads.");
    }

    private void AwaitNotReopened() =>
        Waits.Reached(() => _index.Status is { State: LoadOrderState.Failed, Message: { } message } && message.Contains("not reopened", StringComparison.Ordinal),
            "the status saying the record index was not reopened");

    private void ReceiveTheFixture() =>
        _index.Receive(_holder, LoadOrderArrival.Snapshot(_fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, _fixture.Plugins));

    [Fact]
    public async Task ARebuild_WhileAReadOutlivesTheDrain_IsRefused_AndNoStoreOpensOnTheFileUntilTheReadEnds()
    {
        var read = await AReadOutlivingEveryDrain();

        var refused = _index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal(StoreRebuildRefusal.StillServingReads, refused?.Refusal);
        AwaitNotReopened();
        await ReadEnds(read);
        _index.NextSnapshotUnsettledUntil(() => _index.Status.State == LoadOrderState.Ready, "the reopened index");
        Assert.NotEmpty(_index.ListedIn(Key));
    }

    [Fact]
    public async Task AnArrivalOnTheSameFile_WhileAReadOutlivesTheDrain_OpensNoStoreBesideIt_UntilTheReadEnds()
    {
        var otherDataFolder = Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, "OtherData")).FullName;
        var read = await AReadOutlivingEveryDrain();

        _index.Receive(_holder, LoadOrderArrival.Snapshot(otherDataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, []));

        AwaitNotReopened();
        await ReadEnds(read);
        ReceiveTheFixture();
        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
        Assert.NotEmpty(_index.ListedIn(Key));
    }

    [Fact]
    public async Task AnArrivalOnAnotherInstance_WhileAReadOutlivesTheDrain_OpensThatInstancesFile()
    {
        using var other = new PluginFixtureBuilder("read-outlives-drain-other").WithPlugin("Other.esp", mod => mod.Npcs.AddNew("OtherNpc")).Build();
        var read = await AReadOutlivingEveryDrain();

        _index.Receive(_holder, LoadOrderArrival.Snapshot(other.DataFolder, other.InstanceRoot, GameRelease.Fallout4, other.Plugins));

        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
        Assert.NotEmpty(_index.ListedIn(other.Plugins.Single().KeyOf()));
        await ReadEnds(read);
    }
}
