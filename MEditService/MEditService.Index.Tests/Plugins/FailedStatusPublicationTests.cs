using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

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
        var faults = new PluginChangedFaults();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: faults);
        index.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        faults.Armed = true;
        PluginBinaries.Rewrite(_fixture.Plugins[0].Path, mod => mod.Npcs.AddNew("WrittenByAnotherTool"));
        var versionAnswered = index.Status.Version;
        var stopped = false;
        var readEarly = false;
        var reader = Task.Run(() =>
        {
            while (!Volatile.Read(ref stopped))
            {
                var status = index.Status;
                if (status.State == LoadOrderState.Failed && status.Version <= versionAnswered) readEarly = true;
            }
        });

        var version = holder.Apply(LoadOrderArrival.Snapshot(
            _fixture.GameDirectory, _fixture.InstanceRoot, GameRelease.Fallout4, [_fixture.Plugins[0]]));
        Waits.Reached(() => index.Status.Version >= version, "the status answering the arrival");
        Volatile.Write(ref stopped, true);
        await reader;

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.False(readEarly);
    }

    private sealed class PluginChangedFaults : INotificationPublisher
    {
        public bool Armed { get; set; }

        public void Publish(Notification notification)
        {
            if (Armed && notification is PluginChangedNotification) throw new InvalidOperationException("the stream could not take the push");
        }
    }
}
