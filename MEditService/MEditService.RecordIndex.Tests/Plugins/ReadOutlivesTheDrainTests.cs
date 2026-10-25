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

    private const string SlowReadsOwnText = "steps(n)";

    private const string SecondsLongReadOnOneCore =
        $"WITH RECURSIVE {SlowReadsOwnText} AS (SELECT 1 UNION ALL SELECT n + 1 FROM steps WHERE n < 60000) SELECT count(*) AS n FROM steps";

    private const string NotReopened =
        "mEdit's record index was not reopened: a read of it was still open after 120s. It is retried with the next load order.";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("read-outlives-drain")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew("DrainedNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly LeapingClock _clock = new();
    private readonly OpenedIndex _index;

    public ReadOutlivesTheDrainTests()
    {
        _index = OpenIndex(_holder);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _clock.StopLeaping();
        _index.Dispose();
        _fixture.Dispose();
    }

    private OpenedIndex OpenIndex(LoadOrderHolder holder, AbortingTreeSource? source = null) =>
        Indexes.Open(holder, new MutagenPluginAdapter(TimeProvider.System), timeProvider: _clock, source: source);

    private PluginAddress Key => _fixture.Plugins.Single().Key;

    private async Task<Task<Answer<SelectedRows, IndexRefused>>> AReadOutlivingEveryDrain(OpenedIndex index, string instanceRoot)
    {
        index.Queries.SelectRows("SELECT 1 AS n").Value();
        IndexFiles.LogQueries(instanceRoot);
        var read = Task.Run(() => index.Queries.SelectRows(SecondsLongReadOnOneCore));
        Assert.True(await Waits.Until(() => read.IsCompleted || IndexFiles.Started(instanceRoot, SlowReadsOwnText)), "The slow read never started.");
        Assert.False(read.IsCompleted, "The slow read ended before the drain it is meant to outlive.");
        _clock.StartLeaping();
        return read;
    }

    private async Task ReadEnds(Task<Answer<SelectedRows, IndexRefused>> read)
    {
        _clock.StopLeaping();
        Assert.True((await read.WaitAsync(Waits.Patience)).Holds(out _, out _), "The slow read was refused.");
    }

    private void AwaitNotReopened() =>
        Waits.Reached(() => _index.Status is { State: LoadOrderState.Failed, Message: NotReopened }, "the status saying the record index was not reopened");

    private void ReceiveTheFixture() =>
        _index.Receive(_holder, SnapshotPlugins.Snapshot(_fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, _fixture.Plugins));

    [Fact]
    public async Task ARebuild_WhileAReadOutlivesTheDrain_IsRefused_AndNoStoreOpensOnTheFileUntilTheReadEnds()
    {
        var read = await AReadOutlivingEveryDrain(_index, _fixture.InstanceRoot);

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
        var read = await AReadOutlivingEveryDrain(_index, _fixture.InstanceRoot);

        _index.Receive(_holder, SnapshotPlugins.Snapshot(otherDataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, []));

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
        var read = await AReadOutlivingEveryDrain(_index, _fixture.InstanceRoot);

        _index.Receive(_holder, SnapshotPlugins.Snapshot(other.DataFolder, other.InstanceRoot, GameRelease.Fallout4, other.Plugins));

        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
        Assert.NotEmpty(_index.ListedIn(other.Plugins.Single().Key));
        await ReadEnds(read);
    }

    [Fact]
    public async Task AReopenAfterTheFileIsInvalidated_WhileAReadOutlivesTheDrain_SaysOnceThatItWasNotReopened()
    {
        using var compiled = new PluginFixtureBuilder("read-outlives-drain-reopen")
            .WithPlugin("Tree.esp", mod => mod.Npcs.AddNew("TreeNpc"), origin: "TreeMod")
            .BuildScattered()
            .CompiledPlugin();
        var source = new AbortingTreeSource(compiled.InstanceRoot);
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder, source);
        index.Reconcile(holder, compiled.DataFolder, [], GameRelease.Fallout4, compiled.InstanceRoot);
        var read = await AReadOutlivingEveryDrain(index, compiled.InstanceRoot);
        source.Arm();

        index.Reconcile(holder, compiled.DataFolder, compiled.Plugins, GameRelease.Fallout4, compiled.InstanceRoot);

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.EndsWith($" {NotReopened}", index.Status.Message);
        _clock.StopLeaping();
        await read.WaitAsync(Waits.Patience);
    }
}
