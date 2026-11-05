using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReconcileDoorTests
{

    private static async Task ParkedCheckFinding(
        OpenedIndex index, GatedPluginAdapter gate, InMemoryNotificationPublisher notifications, LoadOrderEntry plugin)
    {
        var before = notifications.Notifications.Count;
        gate.ParkNextOpenOf(plugin.Name);
        PluginBinaries.Touch(plugin.Path);
        index.SignalChange();
        await gate.WaitUntilParkedAsync();
        gate.Release();
        Waits.Reached(() => notifications.Since(before).Any(n => Announcements.PluginChanged(plugin)(n)), "the parked check's announcement");
    }

    private static LoadOrderStatusNotification[] StatusesPublished(InMemoryNotificationPublisher notifications) =>
        [.. notifications.Notifications.OfType<LoadOrderStatusNotification>()];

    [ForeignIndexHolderFact]
    public void AnotherWindowHoldsTheInstance_IsAnsweredAsHeldElsewhereStatus_ReadsNothing_MintsNoFile_AndLoadsOnceReleased()
    {
        using var data = new PluginFixtureBuilder("held-elsewhere-door").WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA")).Build();
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder))
            earlier.Reconcile(earlierHolder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var indexFolder = Path.GetDirectoryName(IndexFiles.In(data.InstanceRoot)).Require();
        using var otherWindow = ForeignIndexHolder.Hold(IndexFiles.In(data.InstanceRoot));
        var filesWhileHeld = Directory.GetFiles(indexFolder).Order(StringComparer.Ordinal).ToList();
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);

        var version = index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        Assert.Equal(LoadOrderState.HeldElsewhere, index.Status.State);
        Assert.Equal(version, index.Status.Version);
        Assert.NotNull(index.Status.Message);
        Assert.Contains("another Modbench window", index.Status.Message, StringComparison.Ordinal);
        var published = Assert.Single(StatusesPublished(notifications));
        Assert.Equal(LoadOrderState.HeldElsewhere, published.Status.State);
        Assert.Equal(index.Status.Message, published.Status.Message);
        Assert.Equal(IndexRefusal.NoLoadOrder, index.Queries.GetPlugins().Refused().Refusal);
        Assert.Equal(filesWhileHeld, Directory.GetFiles(indexFolder).Order(StringComparer.Ordinal));

        otherWindow.Dispose();
        index.NextCheckUntil(() => index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status");
        Assert.Equal(["FromA"], index.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)).Select(row => row.EditorId));
    }

    [Fact]
    public void AReconcileThatFails_IsAnsweredAsFailedStatus_WithTheReason_NotThrown()
    {
        using var data = new PluginFixtureBuilder("failed-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);

        var version = index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Oblivion, data.Plugins));

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.Equal(version, index.Status.Version);
        Assert.Contains("Oblivion", index.Status.Message, StringComparison.Ordinal);
        var published = Assert.Single(StatusesPublished(notifications)).Status;
        Assert.Equal(LoadOrderState.Failed, published.State);
        Assert.Equal(version, published.Version);
        Assert.Equal(index.Status.Message, published.Message);
    }

    private static PluginFixtureData AReadThenB() => new PluginFixtureBuilder("cut-short-door")
        .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
        .WithPlugin("B.esp", mod =>
        {
            mod.Npcs.AddNew("FromB1");
            mod.Npcs.AddNew("FromB2");
        })
        .Build();

    private static readonly PluginAddress A = new("A.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress B = new("B.esp", PluginOrigin.DataDirectory);

    [Fact]
    public void APluginWhoseReadRunsOutOfMemory_FailsToRead_AndTheRestLand()
    {
        using var data = AReadThenB();
        var thrown = Faults.Of(typeof(OutOfMemoryException));
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 1, () => throw thrown));

        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Contains(thrown.Message, Assert.Single(index.Status.Failures, f => f.Name == "B.esp").Reason, StringComparison.Ordinal);
        Assert.NotEmpty(index.ListedIn(A));
    }

    [Fact]
    public void APluginWhoseReadRanOutOfMemory_IsNotReadAgain_WhileItsBytesHold()
    {
        using var data = AReadThenB();
        var readsOfB = 0;
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 1, () =>
        {
            Interlocked.Increment(ref readsOfB);
            throw Faults.Of(typeof(OutOfMemoryException));
        }));
        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        var rewrittenA = new Fallout4Mod(ModKey.FromFileName(A.Name), Fallout4Release.Fallout4);
        rewrittenA.Npcs.AddNew("FromARewritten");
        rewrittenA.WriteToBinary(data.Plugins.Single(p => p.Name == A.Name).Path);
        index.NextCheckUntil(() => index.ListedIn(A).Any(row => row.EditorId == "FromARewritten"), "A's rewritten record");

        Assert.Equal(1, Volatile.Read(ref readsOfB));
        Assert.Contains(index.Status.Failures, f => f.Name == B.Name);
    }

    [Fact]
    public void APluginWhoseReadAgainRunsOutOfMemory_FailsToRead()
    {
        using var data = AReadThenB();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 1, Faults.InTurn(null, typeof(OutOfMemoryException))));
        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        PluginBinaries.Touch(data.Plugins.Single(p => p.Name == B.Name).Path);
        index.NextCheckUntil(() => index.Status.Failures.Any(f => f.Name == B.Name), "B's failure");

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.StartsWith("Could not read this plugin", index.Status.Failures.Single(f => f.Name == B.Name).Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(OperationCanceledException))]
    public void APluginWhoseReadWasCutShort_IsReadByTheNextCheck_AndListed(Type thrownType)
    {
        using var data = AReadThenB();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 1, Faults.InTurn(thrownType)));
        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        index.NextCheckUntil(() => index.Status.State == LoadOrderState.Ready, "the next check's ready status");

        Assert.Contains(B, index.Status.IndexedPlugins);
        Assert.Equal(2, index.CountOf(B, "npc_"));
    }

    [Fact]
    public void APluginReadAgain_IsListed_ThoughTheValidationFailsAtTheNextPlugin()
    {
        using var data = new PluginFixtureBuilder("landed-before-throw-door")
            .WithPlugin("B.esp", mod =>
            {
                mod.Npcs.AddNew("FromB1");
                mod.Npcs.AddNew("FromB2");
            })
            .WithPlugin("C.esp", mod =>
            {
                mod.Npcs.AddNew("FromC1");
                mod.Npcs.AddNew("FromC2");
            })
            .Build();
        var holder = new LoadOrderHolder();
        Action failRead = () => throw Faults.Of(typeof(InvalidOperationException));
        Action abortCheckpoint = () => IndexFiles.AbortNextCheckpoint(data.InstanceRoot);
        var readB = failRead;
        var readC = failRead;
        var readCAgain = abortCheckpoint;
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 1, Faults.InTurn(readB, readC, null, readCAgain)));

        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.Contains(B, index.Status.IndexedPlugins);
        Assert.Equal(2, index.CountOf(B, "npc_"));
    }

    [Fact]
    public void AFailedReconcile_IsTriedAgain_ByAnEqualSnapshot()
    {
        using var data = new PluginFixtureBuilder("retry-door").WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA")).Build();
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder))
            earlier.Reconcile(earlierHolder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var blocker = Path.GetDirectoryName(IndexFiles.In(data.InstanceRoot))
            ?? throw new InvalidOperationException("The record index file sits in a folder.");
        Directory.Delete(blocker, recursive: true);
        File.WriteAllText(blocker, "not a folder");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        var snapshot = SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);
        index.Receive(holder, snapshot);
        Assert.Equal(LoadOrderState.Failed, index.Status.State);

        File.Delete(blocker);
        index.NextCheckUntil(() => index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status");
        Assert.NotEmpty(index.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
    }

    [Fact]
    public void AStatusThatFailsToPublish_StrandsNeitherTheReconcileNorTheNext()
    {
        using var data = new PluginFixtureBuilder("publish-fault-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher { FaultsOn = n => n is LoadOrderStatusNotification };
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);
        var first = holder.Apply(SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));
        index.AwaitVersion(first);
        notifications.FaultsOn = null;

        var second = holder.Apply(SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, []));

        Assert.True(
            Waits.ReachedWithin(() => index.Status.Version >= second && index.Status.State == LoadOrderState.Ready, TimeSpan.FromSeconds(30)),
            "the next reconcile answering after a status failed to publish");
    }

    [Fact]
    public void AStatusWhosePublishFailed_IsToldAgainOnceTheFaultLifts_WithNoStatusChange()
    {
        using var data = new PluginFixtureBuilder("retold-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher
        {
            FaultsOn = n => n is LoadOrderStatusNotification { Status.State: LoadOrderState.Ready },
        };
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);
        var version = holder.Apply(SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));
        index.AwaitVersion(version);
        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the ready state");
        notifications.FaultsOn = null;

        holder.Apply(holder.Current);

        Assert.True(
            Waits.ReachedWithin(() => StatusesPublished(notifications).LastOrDefault()?.Status.State == LoadOrderState.Ready, TimeSpan.FromSeconds(20)),
            "the ready status being published once the fault lifted");
    }

    [Fact]
    public void AReconcileThatStillFails_IsTriedOncePerEqualSnapshot()
    {
        using var data = new PluginFixtureBuilder("retry-once-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var opens = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, opens, notifications: notifications);
        var snapshot = SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Oblivion, data.Plugins);
        index.Receive(holder, snapshot);
        var before = StatusesPublished(notifications).Length;

        index.NextCheckUnsettledUntil(() => StatusesPublished(notifications).Length > before, "the retried reconcile's failed status");
        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Oblivion, []));

        var retried = StatusesPublished(notifications)[before..];
        Assert.Equal(2, retried.Length);
        Assert.All(retried, n => Assert.Equal(LoadOrderState.Failed, n.Status.State));
        Assert.Equal(0, opens.OpenedTotal);
    }

    [ForeignIndexHolderFact]
    public void ARefreshAfterTheOtherWindowCloses_TakesTheRecordIndex_AndClearsTheRefusal()
    {
        using var data = new PluginFixtureBuilder("takeover-door").WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA")).Build();
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder))
            earlier.Reconcile(earlierHolder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        using var otherWindow = ForeignIndexHolder.Hold(IndexFiles.In(data.InstanceRoot));
        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));
        Assert.Equal(LoadOrderState.HeldElsewhere, index.Status.State);
        Assert.Contains("Close that window, then refresh.", index.Status.Message, StringComparison.Ordinal);

        otherWindow.Dispose();
        Assert.Null(index.Queries.RebuildStore(GameRelease.Fallout4, data.InstanceRoot));

        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the refresh's ready status");
        Assert.Null(index.Status.Message);
        Assert.Equal(["FromA"], index.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)).Select(row => row.EditorId));
    }

    [Fact]
    public async Task AnIdenticalResend_AnswersTheVersionAlreadyReady_AndTheChecksAfterAnnounceOnlyWhatChangedOnDisk()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("no-op-door").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        using var gate = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, gate, notifications: notifications);
        var snapshot = SnapshotPlugins.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins);
        var first = index.Receive(holder, snapshot);
        var before = notifications.Notifications.Count;

        holder.Apply(snapshot);
        await ParkedCheckFinding(index, gate, notifications, fx.Plugins[0]);
        var announced = index.AnnouncedByChecks(notifications, () => Announcements.Touched(fx.Plugins[0]));

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(first, index.Status.Version);
        Assert.All(notifications.Since(before).WithoutValidations(), n => Assert.True(Announcements.PluginChanged(fx.Plugins[0])(n)));
        Assert.Equal(2, announced.Count);
    }

    [Fact]
    public async Task AnArrivalsStatus_IsPublishedBeforeItsVersionIsAnswered()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("status-before-version").WithPlugin("A.esp").Build();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Open(holder, notifications: notifications);
        var answered = index.Status.Version;
        var publishing = false;
        var release = new TaskCompletionSource();
        notifications.OnPublish = n =>
        {
            if (n is not LoadOrderStatusNotification status || status.Status.Version <= answered) return;
            Volatile.Write(ref publishing, true);
            release.Task.Wait();
        };

        try
        {
            var version = holder.Apply(SnapshotPlugins.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins));
            Waits.Reached(() => Volatile.Read(ref publishing), "the arrival's status being published");
            var read = Task.Run(() => index.Status.Version);

            Assert.False(await Waits.CompletesWithin(read, TimeSpan.FromMilliseconds(300)));
            release.TrySetResult();
            Assert.Equal(version, await read);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task AReconcileInFlight_FinishesThroughLaterArrivals_WhichFoldIntoOneMore()
    {
        using var fx = new PluginFixtureBuilder("folded-door")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();
        var log = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(log)));
        int Reconciles()
        {
            lock (log) return log.Count(e => e.Message.StartsWith("Reconciling load order", StringComparison.Ordinal));
        }
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        using var index = Indexes.Open(holder, gate, loggerFactory: loggerFactory, notifications: notifications);
        var first = holder.Apply(SnapshotPlugins.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins));
        await gate.WaitUntilParkedAsync();

        var second = holder.Apply(SnapshotPlugins.Snapshot(
            fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, [fx.Plugins[0] with { Enabled = false }, .. fx.Plugins.Skip(1)]));
        holder.Apply(holder.Current);
        gate.Release();
        index.AwaitVersion(second);
        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the reconcile after the arrivals");
        await Task.Delay(TimeSpan.FromMilliseconds(500));

        Assert.Contains(StatusesPublished(notifications), n => n.Status.State == LoadOrderState.Ready && n.Status.Version == first);
        Assert.Equal(2, Reconciles());
        Assert.Equal(second, index.Status.Version);
    }
}
