using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

public sealed class ReconcileDoorTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    private static LoadOrderStatusNotification[] StatusesPublished(InMemoryNotificationPublisher notifications) =>
        [.. notifications.Notifications.OfType<LoadOrderStatusNotification>()];

    [ForeignIndexHolderFact]
    public void AnotherWindowHoldsTheInstance_IsAnsweredAsHeldElsewhereStatus_NotThrown()
    {
        using var data = new PluginFixtureBuilder("held-elsewhere-door").WithPlugin("A.esp").Build();
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder))
            earlier.Reconcile(earlierHolder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        using var otherWindow = ForeignIndexHolder.Hold(IndexFiles.In(data.InstanceRoot));
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);

        var version = index.Receive(holder, LoadOrderArrival.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

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

        var version = index.Receive(holder, LoadOrderArrival.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.SkyrimSE, data.Plugins));

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.Equal(version, index.Status.Version);
        Assert.Contains("SkyrimSE", index.Status.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderState.Failed, Assert.Single(StatusesPublished(notifications)).Status.State);
    }

    [Fact]
    public void AFailedReconcile_IsTriedAgain_ByAnEqualSnapshot()
    {
        using var data = new PluginFixtureBuilder("retry-door").WithPlugin("A.esp").Build();
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder))
            earlier.Reconcile(earlierHolder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var blocker = Path.GetDirectoryName(IndexFiles.In(data.InstanceRoot))
            ?? throw new InvalidOperationException("The index file sits in a folder.");
        Directory.Delete(blocker, recursive: true);
        File.WriteAllText(blocker, "not a folder");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        var snapshot = LoadOrderArrival.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);
        index.Receive(holder, snapshot);
        Assert.Equal(LoadOrderState.Failed, index.Status.State);

        File.Delete(blocker);
        holder.Apply(snapshot);

        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status", Patience);
        Assert.NotEmpty(index.RequireReads().GetDocuments(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
    }

    [Fact]
    public void AReconcileThatStillFails_IsTriedOncePerEqualSnapshot()
    {
        using var data = new PluginFixtureBuilder("retry-once-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);
        var snapshot = LoadOrderArrival.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.SkyrimSE, data.Plugins);
        index.Receive(holder, snapshot);
        var before = StatusesPublished(notifications).Length;

        holder.Apply(snapshot);

        Waits.Reached(() => StatusesPublished(notifications).Length > before, "the retried reconcile's failed status", Patience);
        Assert.Equal(LoadOrderState.Failed, Assert.Single(StatusesPublished(notifications)[before..]).Status.State);
    }

    [Fact]
    public async Task AnEqualSnapshot_OfAnIndexThatHasNotFailed_PublishesNoStatus()
    {
        using var data = new PluginFixtureBuilder("retry-ready-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, gate, notifications: notifications);
        var snapshot = LoadOrderArrival.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);
        index.Receive(holder, snapshot);
        var before = StatusesPublished(notifications).Length;
        var sequence = index.Sequence;
        PluginBinaries.Touch(data.Plugins[0].Path);
        gate.ParkNextOpenOf("A.esp");

        holder.Apply(snapshot);
        await gate.WaitUntilParkedAsync();
        gate.Release();

        Assert.True(await index.AwaitSequenceAsync(sequence + 1, Patience));
        Assert.Equal(before, StatusesPublished(notifications).Length);
    }

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

        var first = holder.Apply(LoadOrderArrival.Snapshot(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins));
        await gate.WaitUntilParkedAsync();
        var second = holder.Apply(LoadOrderArrival.Snapshot(
            fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, [fx.Plugins[0] with { Enabled = false }, .. fx.Plugins.Skip(1)]));
        gate.Release();
        index.AwaitVersion(second);

        Assert.NotEqual(first, second);
        Waits.Reached(
            () => StatusesPublished(notifications).Any(n => n.Status.State == LoadOrderState.Ready && n.Status.Version == second),
            "the survivor's ready status", Patience);
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(second, index.Status.Version);
        Assert.DoesNotContain(StatusesPublished(notifications), n => n.Status.State == LoadOrderState.HeldElsewhere);
    }

    [Fact]
    public void AnIdenticalResend_AnswersTheVersionAlreadyReady_AndPublishesNothing()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("no-op-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Open(holder, notifications: notifications);
        var snapshot = LoadOrderArrival.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);
        var first = index.Receive(holder, snapshot);
        var before = notifications.Notifications.Count;

        var second = holder.Apply(snapshot);
        PluginBinaries.Touch(fx.Plugins[0].Path);
        holder.Apply(snapshot);

        Waits.Reached(() => notifications.Notifications.Count > before, "the touched plugin's announcement", Patience);
        Assert.Equal(first, second);
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(first, index.Status.Version);
        Assert.IsType<PluginChangedNotification>(Assert.Single(notifications.Notifications.Skip(before)));
    }

    [Fact]
    public void AnAppliedLoadOrder_IsReconciledOffTheAppliersThread_UntilTheStatusAnswersItsVersion()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sync-door").WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA")).Build();
        using var index = Indexes.Open(holder);

        index.Receive(holder, LoadOrderArrival.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins));

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.NotEmpty(index.RequireReads().GetDocuments(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
    }
}
