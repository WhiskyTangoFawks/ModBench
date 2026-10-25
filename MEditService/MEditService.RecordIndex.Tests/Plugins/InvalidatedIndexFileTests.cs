using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class InvalidatedIndexFileTests : IDisposable
{
    private const string Before = "Before.esp";
    private const string Aborted = "Aborted.esp";
    private const string After = "After.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("invalidated-index-file")
        .WithPlugin(Before, mod => mod.Npcs.AddNew("BeforeNpc"))
        .WithPlugin(Aborted, mod => mod.Npcs.AddNew("AbortedNpc"))
        .WithPlugin(After, mod => mod.Npcs.AddNew("AfterNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;

    public InvalidatedIndexFileTests()
    {
        _index = Indexes.Open(_holder, new AbortingDuckDbsCheckpoint(_fixture.InstanceRoot, Aborted, nthRead: 2), notifications: _notifications);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var rewritten = new Fallout4Mod(ModKey.FromFileName(Aborted), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("RewrittenNpc");
        rewritten.WriteToBinary(_fixture.Plugins.Single(p => p.Name == Aborted).Path);
        _index.NextSnapshotUnsettledUntil(() => _index.Status.State == LoadOrderState.Failed, "the validation failing");
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void AFatalErrorInTheIndexFile_FailsTheSnapshot_AndBlamesNoPlugin()
    {
        var status = _index.Status;

        Assert.Empty(status.Failures);
        Assert.Equal(LoadOrderState.Failed, status.State);
    }

    [Fact]
    public void AFatalError_LeavesThePluginsReadBeforeItAnswering_BeforeTheNextSnapshot()
    {
        var read = _index.ListedIn(_fixture.Plugins.Single(p => p.Name == Before).Key);

        Assert.Single(read);
        Assert.Equal([Aborted, After, Before], PublishedIndexedPlugins());
        Assert.Equal([Aborted, After, Before], _index.Status.IndexedPlugins.Select(p => p.Name).Order());
    }

    private string[] PublishedIndexedPlugins() =>
        [.. _notifications.Notifications.OfType<LoadOrderStatusNotification>().Last().Status.IndexedPlugins.Select(p => p.Name).Order()];

    [Fact]
    public void TheNextSnapshotAfterAFatalError_OpensTheIndexFileAgain_AndReadsEveryPlugin()
    {
        var before = _notifications.Notifications.Count;
        _index.NextSnapshotUnsettledUntil(() => Answered(before) is not null, "the snapshot's answer");

        Assert.Equal(LoadOrderState.Ready, Answered(before));
        Assert.Equal([Aborted, After, Before], _index.Status.IndexedPlugins.Select(p => p.Name).Order());
    }

    private LoadOrderState? Answered(int before) =>
        _notifications.Since(before).OfType<LoadOrderStatusNotification>()
            .Select(n => (LoadOrderState?)n.Status.State).LastOrDefault(state => state is LoadOrderState.Ready or LoadOrderState.Failed);
}
