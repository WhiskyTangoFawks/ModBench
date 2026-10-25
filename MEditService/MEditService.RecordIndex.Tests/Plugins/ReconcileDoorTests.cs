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

    private static async Task ParkedEqualArrivalFinding(
        LoadOrderHolder holder, GatedPluginAdapter gate, InMemoryNotificationPublisher notifications, LoadOrderEntry plugin)
    {
        var before = notifications.Notifications.Count;
        gate.ParkNextOpenOf(plugin.Name);
        PluginBinaries.Touch(plugin.Path);
        holder.Apply(holder.Current);
        await gate.WaitUntilParkedAsync();
        gate.Release();
        Waits.Reached(() => notifications.Since(before).Any(n => Announcements.PluginChanged(plugin)(n)), "the parked arrival's announcement");
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
        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status");
        Assert.NotEmpty(index.ListedIn(new PluginAddress("A.esp", PluginOrigin.DataDirectory)));
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
        index.NextSnapshotUntil(() => index.ListedIn(A).Any(row => row.EditorId == "FromARewritten"), "A's rewritten record");

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
        index.NextSnapshotUntil(() => index.Status.Failures.Any(f => f.Name == B.Name), "B's failure");

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.StartsWith("Could not read this plugin", index.Status.Failures.Single(f => f.Name == B.Name).Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(OperationCanceledException))]
    public void APluginWhoseReadWasCutShort_IsReadByTheNextSnapshot_AndListed(Type thrownType)
    {
        using var data = AReadThenB();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 1, Faults.InTurn(thrownType)));
        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Ready, "the next snapshot's ready status");

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
        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status");
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
    public async Task AFailureCleared_ByAnAttemptSupersededBeforeItsClosingSwap_IsToldByItsSuccessor()
    {
        using var data = new PluginFixtureBuilder("superseded-untold-door")
            .WithPlugin("NonCompiledPlugin.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("Other.esp", mod => mod.Npcs.AddNew("FromOther"))
            .Build();
        var notifications = new InMemoryNotificationPublisher { FaultsOn = n => n is PluginChangedNotification };
        var log = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(log)));
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, gate, loggerFactory: loggerFactory, notifications: notifications);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        PluginBinaries.Rewrite(data.Plugins[0].Path, mod => mod.Npcs.AddNew("WrittenByAnotherTool"));
        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Failed, "the failed status");
        notifications.FaultsOn = null;
        PluginBinaries.Rewrite(data.Plugins[0].Path, mod => mod.Npcs.AddNew("WrittenAgain"));
        gate.ParkNextOpenOf(data.Plugins[0].Name);
        holder.Apply(holder.Current);
        Assert.True(await Waits.CompletesWithin(gate.WaitUntilParkedAsync(), TimeSpan.FromSeconds(20)), "the validation re-reading the plugin");

        holder.Apply(holder.Current);
        Waits.Reached(() => { lock (log) return log.Exists(e => e.Message.Contains("Asked the reconcile in flight to stop", StringComparison.Ordinal)); }, "the attempt being asked to stop");
        gate.Release();
        Waits.Reached(() => { lock (log) return log.Exists(e => e.Message.Contains("superseded", StringComparison.Ordinal)); }, "the attempt being superseded");

        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the successor answering Ready");
        Assert.True(
            Waits.ReachedWithin(() => StatusesPublished(notifications).LastOrDefault()?.Status.State == LoadOrderState.Ready, TimeSpan.FromSeconds(20)),
            "the successor publishing the Ready it answers");
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

        index.NextSnapshotUnsettledUntil(() => StatusesPublished(notifications).Length > before, "the retried reconcile's failed status");
        index.Receive(holder, SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Oblivion, []));

        var retried = StatusesPublished(notifications)[before..];
        Assert.Equal(2, retried.Length);
        Assert.All(retried, n => Assert.Equal(LoadOrderState.Failed, n.Status.State));
        Assert.Equal(0, opens.OpenedTotal);
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

        holder.Apply(SnapshotPlugins.Snapshot(fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, fx.Plugins));
        await gate.WaitUntilParkedAsync();
        var second = holder.Apply(SnapshotPlugins.Snapshot(
            fx.DataFolder, fx.InstanceRoot, GameRelease.Fallout4, [fx.Plugins[0] with { Enabled = false }, .. fx.Plugins.Skip(1)]));
        gate.Release();
        index.AwaitVersion(second);

        Waits.Reached(
            () => StatusesPublished(notifications).Any(n => n.Status.State == LoadOrderState.Ready && n.Status.Version == second),
            "the survivor's ready status");
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(second, index.Status.Version);
        Assert.DoesNotContain(StatusesPublished(notifications), n => n.Status.State == LoadOrderState.HeldElsewhere);
    }

    [Fact]
    public async Task AnIdenticalResend_AnswersTheVersionAlreadyReady_AndAnnouncesOnlyWhatChangedOnDisk()
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
        await ParkedEqualArrivalFinding(holder, gate, notifications, fx.Plugins[0]);
        var announced = index.AnnouncedByEqualArrivals(notifications, () => Announcements.Touched(fx.Plugins[0]));

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(first, index.Status.Version);
        Assert.All(notifications.Since(before), n => Assert.True(Announcements.PluginChanged(fx.Plugins[0])(n)));
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
    public async Task ArrivalsDuringAReconcile_AreReconciledOnceAfterIt()
    {
        using var data = new PluginFixtureBuilder("coalesced-door").WithPlugin("A.esp").Build();
        var log = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(log)));
        int Reconciles()
        {
            lock (log) return log.Count(e => e.Message.StartsWith("Reconciling load order", StringComparison.Ordinal));
        }
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "A.esp");
        using var index = Indexes.Open(holder, gate, loggerFactory: loggerFactory);
        holder.Apply(SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));
        await gate.WaitUntilParkedAsync();

        holder.Apply(holder.Current);
        holder.Apply(holder.Current);
        gate.Release();
        Waits.Reached(() => Reconciles() >= 2 && index.Status.State == LoadOrderState.Ready, "the reconcile after the arrivals");
        await Task.Delay(TimeSpan.FromMilliseconds(500));

        Assert.Equal(2, Reconciles());
    }
}
