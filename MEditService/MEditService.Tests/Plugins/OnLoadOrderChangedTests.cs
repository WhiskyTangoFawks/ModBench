using MEditService.Codec.Schema;
using MEditService.Http;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// ADR-0013/ADR-0014 invariant 3: Load order state's Changed subscriber is where the Index turns
// its own known refusal into status data — the composition root's catch never sees it.
public sealed class OnLoadOrderChangedTests
{
    private static IndexProjector MakeIndex(LoadOrderHolder holder, InMemoryNotificationPublisher notifications)
    {
        var reflector = SharedSchemaReflector.Instance;
        return new IndexProjector(
            holder, MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)), notifications: notifications);
    }

    private static (IndexProjector Index, GatedIndexRepositoryFactory Gate) MakeGatedIndex(
        LoadOrderHolder holder, InMemoryNotificationPublisher notifications, string gateBefore)
    {
        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var gate = new GatedIndexRepositoryFactory(inner, gateBefore);
        var index = new IndexProjector(holder, MutagenPluginAdapter.Instance, gate, notifications: notifications);
        return (index, gate);
    }

    // The rival this pins: the composition root's own try/catch swallowing the refusal, which
    // would leave Status at None with no way for the extension to learn "another window has this".
    [ForeignIndexHolderFact]
    public void AnotherWindowHoldsTheInstance_PublishesHeldElsewhereStatus_WithTheOldRefusalMessage()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("held-elsewhere-subscriber").WithPlugin("A.esp").Build();
        using var otherWindow = ForeignIndexHolder.Hold(IndexFile.For(data.InstanceRoot));
        var notifications = new InMemoryNotificationPublisher();
        using var index = MakeIndex(holder, notifications);
        var snapshot = ForcedPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);

        index.OnLoadOrderChanged(snapshot);

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
        var (index, gate) = MakeGatedIndex(holder, notifications, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;

        var first = Task.Run(() => index.OnLoadOrderChanged(
            ForcedPlugins.Snapshot(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins)));
        await gate.WaitUntilParkedAsync();

        var second = Task.Run(() => index.OnLoadOrderChanged(
            ForcedPlugins.Snapshot(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins)));
        var secondCompletedBeforeTheFirstStopped = await Task.WhenAny(second, Task.Delay(TimeSpan.FromMilliseconds(500))) == second;
        Assert.False(secondCompletedBeforeTheFirstStopped);

        gate.Release();
        Assert.Null(await Record.ExceptionAsync(() => first));
        await second;

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.DoesNotContain(notifications.Notifications.OfType<LoadOrderStatusNotification>(),
            n => n.Status.State == LoadOrderState.HeldElsewhere);
    }

    private static async Task<bool> CompletesWithin(Task task, TimeSpan timeout) =>
        await Task.WhenAny(task, Task.Delay(timeout)) == task;

    // The rival this pins: a SubscribeTo that calls OnLoadOrderChanged directly on the caller's own
    // thread, which would make holder.Apply itself wait out the gated reconcile below.
    [Fact]
    public async Task SubscribeTo_SchedulesTheReconcileOffTheCallersThread()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("subscribe-index-subscriber").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        var (index, gate) = MakeGatedIndex(holder, notifications, gateBefore: "A.esp");
        using var _ = index;
        using var __ = gate;
        index.SubscribeTo(holder);
        var snapshot = ForcedPlugins.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);

        var applied = Task.Run(() => holder.Apply(snapshot));
        Assert.True(await CompletesWithin(applied, TimeSpan.FromSeconds(5)),
            "holder.Apply waited on the reconcile instead of returning at once");

        await gate.WaitUntilParkedAsync();
        gate.Release();

        var reachedReady = await CompletesWithin(
            Task.Run(async () =>
            {
                while (index.Status.State != LoadOrderState.Ready) await Task.Delay(20);
            }),
            TimeSpan.FromSeconds(10));
        Assert.True(reachedReady, "the subscribed reconcile never reached Ready");
    }
}
