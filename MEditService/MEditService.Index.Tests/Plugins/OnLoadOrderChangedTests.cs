using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// ADR-0013/ADR-0014 invariant 3: Load order state's Changed subscriber is where the Index turns
// its own known refusal into status data — the composition root's catch never sees it.
public sealed class OnLoadOrderChangedTests
{
    private static IndexProjector SubscribedIndex(LoadOrderHolder holder, InMemoryNotificationPublisher notifications)
    {
        var index = Indexes.Open(holder, notifications: notifications);
        index.SubscribeTo(holder);
        return index;
    }

    private static (IndexProjector Index, GatedPluginAdapter Gate) SubscribedGatedIndex(
        LoadOrderHolder holder, InMemoryNotificationPublisher notifications, string gateBefore)
    {
        var gate = new GatedPluginAdapter(gateBefore);
        var index = Indexes.Open(holder, gate, notifications: notifications);
        index.SubscribeTo(holder);
        return (index, gate);
    }

    private static async Task AwaitVersion(IndexProjector index, long version)
    {
        Assert.True(
            await Waits.Until(() => index.Status.Version >= version && index.Status.State != LoadOrderState.Reconciling),
            $"the subscribed reconcile never answered for version {version}; status is {index.Status.State} at version {index.Status.Version}");
    }

    // The rival this pins: the composition root's own try/catch swallowing the refusal, which
    // would leave Status at None with no way for the extension to learn "another window has this".
    [ForeignIndexHolderFact]
    public async Task AnotherWindowHoldsTheInstance_PublishesHeldElsewhereStatus_WithTheOldRefusalMessage()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("held-elsewhere-subscriber").WithPlugin("A.esp").Build();
        // The file exists before the other window takes it: an earlier launch on this instance made it.
        using (var earlier = Indexes.Open(new LoadOrderHolder()))
            earlier.Reconcile(new LoadOrderHolder(), data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        using var otherWindow = ForeignIndexHolder.Hold(IndexFiles.In(data.InstanceRoot));
        var notifications = new InMemoryNotificationPublisher();
        using var index = SubscribedIndex(holder, notifications);
        var snapshot = IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);

        var version = holder.Apply(snapshot);
        await AwaitVersion(index, version);

        Assert.Equal(LoadOrderState.HeldElsewhere, index.Status.State);
        Assert.NotNull(index.Status.Message);
        Assert.Contains("another Modbench window", index.Status.Message, StringComparison.Ordinal);

        var published = Assert.Single(notifications.Notifications.OfType<LoadOrderStatusNotification>());
        Assert.Equal(LoadOrderState.HeldElsewhere, published.Status.State);
        Assert.Equal(index.Status.Message, published.Status.Message);
    }

    // A superseded reconcile is ordinary (a watcher firing mid-load): never an escaped exception,
    // never mistaken for the held-elsewhere refusal, and the survivor still finishes Ready.
    [Fact]
    public async Task ASupersededReconcile_NeverEscapes_AndNeverPublishesHeldElsewhere()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("superseded-subscriber")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();
        var notifications = new InMemoryNotificationPublisher();
        var (index, gate) = SubscribedGatedIndex(holder, notifications, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;
        var snapshot = IndexReconcile.Snapshot(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);

        holder.Apply(snapshot);
        await gate.WaitUntilParkedAsync();

        var second = holder.Apply(snapshot);
        // The second waits for the first to stop rather than running beside it.
        Assert.False(await Waits.Until(() => index.Status.Version >= second, TimeSpan.FromMilliseconds(500)));

        gate.Release();
        await AwaitVersion(index, second);

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(second, index.Status.Version);
        Assert.DoesNotContain(notifications.Notifications.OfType<LoadOrderStatusNotification>(),
            n => n.Status.State == LoadOrderState.HeldElsewhere);
    }

    // The rival this pins: publishing only when Reconcile actually changed something, which would
    // leave a client that applied an identical resend waiting on a tick that never comes.
    [Fact]
    public async Task AnIdenticalResend_StillPublishesATerminalStatus_ForItsOwnVersion()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("no-op-subscriber").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        using var index = SubscribedIndex(holder, notifications);
        var snapshot = IndexReconcile.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);

        var first = holder.Apply(snapshot);
        await AwaitVersion(index, first);
        var second = holder.Apply(snapshot);
        await AwaitVersion(index, second);

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(second, index.Status.Version);
        var ready = notifications.Notifications.OfType<LoadOrderStatusNotification>()
            .Where(n => n.Status.State == LoadOrderState.Ready)
            .Select(n => n.Status.Version)
            .ToList();
        Assert.Equal([first, second], ready);
    }

    // The rival this pins: a SubscribeTo that calls the reconcile directly on the caller's own
    // thread, which would make holder.Apply itself wait out the gated reconcile below.
    [Fact]
    public async Task SubscribeTo_SchedulesTheReconcileOffTheCallersThread()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("subscribe-index-subscriber").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        var (index, gate) = SubscribedGatedIndex(holder, notifications, gateBefore: "A.esp");
        using var _ = index;
        using var __ = gate;
        var snapshot = IndexReconcile.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);

        var applied = Task.Run(() => holder.Apply(snapshot));
        Assert.True(await Waits.CompletesWithin(applied, TimeSpan.FromSeconds(5)),
            "holder.Apply waited on the reconcile instead of returning at once");

        await gate.WaitUntilParkedAsync();
        gate.Release();

        Assert.True(
            await Waits.Until(() => index.Status.State == LoadOrderState.Ready),
            "the subscribed reconcile never reached Ready");
    }
}
