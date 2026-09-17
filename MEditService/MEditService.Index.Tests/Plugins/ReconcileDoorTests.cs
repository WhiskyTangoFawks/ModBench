using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

// The reconcile door takes the snapshot and the version it arrived as, on the caller's thread,
// and turns every outcome into status data: nothing escapes it, and every version is answered.
public sealed class ReconcileDoorTests
{
    private static LoadOrderStatusNotification[] StatusesPublished(InMemoryNotificationPublisher notifications) =>
        [.. notifications.Notifications.OfType<LoadOrderStatusNotification>()];

    // The rival this pins: a door that rethrows the refusal, leaving Status at None with no way
    // for the extension to learn "another window has this".
    [ForeignIndexHolderFact]
    public void AnotherWindowHoldsTheInstance_IsAnsweredAsHeldElsewhereStatus_NotThrown()
    {
        using var data = new PluginFixtureBuilder("held-elsewhere-door").WithPlugin("A.esp").Build();
        using (var earlier = Indexes.Open(new LoadOrderHolder()))
            earlier.Reconcile(new LoadOrderHolder(), data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        using var otherWindow = ForeignIndexHolder.Hold(IndexFiles.In(data.InstanceRoot));
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);
        var snapshot = IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);

        var version = holder.Apply(snapshot);
        index.Reconcile(snapshot, version);

        Assert.Equal(LoadOrderState.HeldElsewhere, index.Status.State);
        Assert.Equal(version, index.Status.Version);
        Assert.NotNull(index.Status.Message);
        Assert.Contains("another Modbench window", index.Status.Message, StringComparison.Ordinal);
        var published = Assert.Single(StatusesPublished(notifications));
        Assert.Equal(LoadOrderState.HeldElsewhere, published.Status.State);
        Assert.Equal(index.Status.Message, published.Status.Message);
    }

    [Fact]
    public void AReconcileThatFails_IsAnsweredAsFailedStatus_WithTheReason_NotThrown()
    {
        using var data = new PluginFixtureBuilder("failed-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);
        var snapshot = IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.SkyrimSE, data.Plugins);

        var version = holder.Apply(snapshot);
        index.Reconcile(snapshot, version);

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.Equal(version, index.Status.Version);
        Assert.Contains("SkyrimSE", index.Status.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderState.Failed, Assert.Single(StatusesPublished(notifications)).Status.State);
    }

    // A superseded reconcile is ordinary (a watcher firing mid-load): never an escaped exception,
    // never mistaken for the held-elsewhere refusal, and the survivor finishes Ready for its version.
    [Fact]
    public async Task ASupersededReconcile_NeverEscapes_AndTheSurvivorAnswersReadyForItsOwnVersion()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("superseded-door")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();
        var notifications = new InMemoryNotificationPublisher();
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        using var index = Indexes.Open(holder, gate, notifications: notifications);
        var snapshot = IndexReconcile.Snapshot(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);

        var first = holder.Apply(snapshot);
        var firstReconcile = Task.Run(() => index.Reconcile(snapshot, first));
        await gate.WaitUntilParkedAsync();
        var second = holder.Apply(snapshot);
        var secondReconcile = Task.Run(() => index.Reconcile(snapshot, second));
        gate.Release();
        await Task.WhenAll(firstReconcile, secondReconcile);

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(second, index.Status.Version);
        Assert.DoesNotContain(StatusesPublished(notifications), n => n.Status.State == LoadOrderState.HeldElsewhere);
        Assert.Equal(second, StatusesPublished(notifications).Last(n => n.Status.State == LoadOrderState.Ready).Status.Version);
    }

    // The rival this pins: publishing only when the reconcile changed something, which would leave
    // a client that applied an identical resend waiting on a tick that never comes.
    [Fact]
    public void AnIdenticalResend_StillPublishesATerminalStatus_ForItsOwnVersion()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("no-op-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Open(holder, notifications: notifications);
        var snapshot = IndexReconcile.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);

        var first = holder.Apply(snapshot);
        index.Reconcile(snapshot, first);
        var second = holder.Apply(snapshot);
        index.Reconcile(snapshot, second);

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(second, index.Status.Version);
        var ready = StatusesPublished(notifications)
            .Where(n => n.Status.State == LoadOrderState.Ready)
            .Select(n => n.Status.Version)
            .ToList();
        Assert.Equal([first, second], ready);
    }

    // The rival this pins: a door that schedules the reconcile and returns, which would make every
    // caller poll for an answer the call itself could have given.
    [Fact]
    public void Reconcile_AnswersOnTheCallersThread_BeforeReturning()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sync-door").WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA")).Build();
        using var index = Indexes.Open(holder);
        var snapshot = IndexReconcile.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);

        index.Reconcile(snapshot, holder.Apply(snapshot));

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.NotEmpty(index.RequireReads().GetDocuments(new PluginCopyKey("A.esp", PluginOrigin.DataDirectory)));
    }
}
