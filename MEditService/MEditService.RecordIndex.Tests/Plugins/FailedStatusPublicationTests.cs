using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class FailedStatusPublicationTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("failed-status")
        .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"), origin: "ModA")
        .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"), origin: "ModB")
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task AFailedState_IsNeverReadBeforeTheStatusAnsweringItsVersion()
    {
        var faults = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: faults);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        faults.FaultsOn = n => n is PluginChangedNotification;
        PluginBinaries.Rewrite(_fixture.Plugins[0].Path, mod => mod.Npcs.AddNew("WrittenByAnotherTool"));
        var versionAnswered = index.Status.Version;

        var readEarly = await Waits.EverSeenWhile(
            () => index.Status is { State: LoadOrderState.Failed } status && status.Version <= versionAnswered,
            () => index.Receive(holder, SnapshotPlugins.Snapshot(
                _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [_fixture.Plugins[0]])));

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.False(readEarly);
    }
}
