using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class InvalidatedOnFirstReadTests : IDisposable
{
    private const string Aborted = "Aborted.esp";
    private const string After = "After.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("invalidated-on-first-read")
        .WithPlugin(Aborted, mod => mod.Npcs.AddNew("AbortedNpc"))
        .WithPlugin(After, mod => mod.Npcs.AddNew("AfterNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public InvalidatedOnFirstReadTests()
    {
        _index = Indexes.Open(_holder, new AbortingDuckDbsCheckpoint(_fixture.InstanceRoot, Aborted, nthRead: 1));
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void AFatalErrorOnAFirstRead_FailsTheLoadOrder_AndLeavesTheIndexFileAnswering()
    {
        Assert.Equal(LoadOrderState.Failed, _index.Status.State);
        Assert.Empty(_index.Status.Failures);
        Assert.Empty(_index.ListedIn(_fixture.Plugins.Single(p => p.Name == Aborted).Key));
    }

    [Fact]
    public void TheNextSnapshotAfterAFatalErrorOnAFirstRead_ReadsEveryPlugin()
    {
        _index.NextSnapshotUntil(() => _index.Status.State == LoadOrderState.Ready, "the snapshot's answer");

        Assert.Equal([Aborted, After], _index.Status.IndexedPlugins.Select(p => p.Name).Order());
    }
}
