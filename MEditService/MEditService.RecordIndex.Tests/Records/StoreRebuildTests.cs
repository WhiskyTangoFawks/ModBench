using System.Diagnostics;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class StoreRebuildTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("store-rebuild")
        .WithPlugin("UFO4P.esp", mod => mod.Npcs.AddNew("NpcBeforeRebuild"), origin: "Unofficial Patch")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly GatedPluginAdapter _opens = new();
    private readonly OpenedIndex _index;

    public StoreRebuildTests() => _index = Indexes.Open(_holder, _opens);

    public void Dispose()
    {
        _index.Dispose();
        _opens.Dispose();
        _fixture.Dispose();
    }

    private PluginAddress Key => _fixture.Plugins.Single().Key;

    private void Reconcile(string? instanceRoot) =>
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, instanceRoot);

    [Fact]
    public void AnEmptySnapshot_ReconcilesToAnIndexThatAnswersNothing()
    {
        _index.Reconcile(_holder, _fixture.DataFolder, [], GameRelease.Fallout4);

        Assert.Equal(0, _index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 1, offset: 0).Value().Total);
    }

    [Fact]
    public void WithNoInstanceRoot_NothingIsKeptBetweenIndexes()
    {
        Reconcile(instanceRoot: null);
        Assert.Equal(1, _opens.OpenedTotal);
        _index.Dispose();

        using var next = Indexes.Open(_holder, _opens);
        next.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(2, _opens.OpenedTotal);
    }

    [Fact]
    public void AnInstanceRootThatIsNotThere_FailsNamingIt_CreatesNothing_AndReopensOnceItReturns()
    {
        var gone = Path.Combine(_fixture.InstanceRoot, "no-such-instance");

        Reconcile(gone);

        Assert.Equal(LoadOrderState.Failed, _index.Status.State);
        Assert.Contains(gone, _index.Status.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(gone));

        Directory.CreateDirectory(gone);
        _index.NextSnapshotUntil(() => _index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status");

        Assert.NotEmpty(_index.ListedIn(Key));
    }

    [Fact]
    public void ARebuildOfAnInstanceRootThatIsNotThere_FailsNamingIt_CreatesNothing_AndReopensOnceItReturns()
    {
        Reconcile(_fixture.InstanceRoot);
        var gone = Path.Combine(_fixture.InstanceRoot, "no-such-instance");

        Assert.Null(_index.Queries.RebuildStore(GameRelease.Fallout4, gone));

        Assert.Equal(LoadOrderState.Failed, _index.Status.State);
        Assert.Contains(gone, _index.Status.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(gone));

        Directory.CreateDirectory(gone);
        _index.NextSnapshotUntil(() => _index.Status.State == LoadOrderState.Ready, "the retried reconcile's ready status");
    }

    [Fact]
    public void ARebuild_ReadsThePluginAgain_AgainstTheLoadOrderHeld()
    {
        Reconcile(_fixture.InstanceRoot);
        Assert.Equal(1, _opens.OpenedTotal);
        var held = _holder.Held?.Version;

        Rebuilt(_index, _fixture.InstanceRoot);

        Assert.Equal(2, _opens.OpenedTotal);
        Assert.Equal(held, _index.Status.Version);
        Assert.NotEmpty(_index.ListedIn(Key));
    }

    private static void Rebuilt(OpenedIndex index, string instanceRoot)
    {
        Assert.Null(index.Queries.RebuildStore(GameRelease.Fallout4, instanceRoot));
        AwaitRefill(index);
    }

    private static void AwaitRefill(OpenedIndex index) =>
        Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the refill");

    private const string MatchesNpcA = "SELECT form_key FROM npc_ WHERE editor_id = 'NpcA'";

    private const string SlowlyMatchesNpcA = MatchesNpcA + " UNION ALL SELECT NULL FROM range(1) WHERE (SELECT sum(range % 7) FROM range(200000000)) < 0";

    private static PluginFixtureData NpcAAndNpcOtherInAespAndNpcBInBespFixture(string name) => new PluginFixtureBuilder(name)
        .WithPlugin("A.esp", mod => { mod.Npcs.AddNew("NpcA"); mod.Npcs.AddNew("NpcOther"); })
        .WithPlugin("B.esp", mod => mod.Npcs.AddNew("NpcB"))
        .Build();

    private static string[] ListedNpcs(OpenedIndex index) =>
        [.. index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Items.Select(i => i.EditorId ?? "")];

    [Fact]
    public void ARebuild_KeepsTheRecordFilter_AndTheRefilledRowsAnswerThroughIt()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-kept");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, _opens);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");

        Rebuilt(index, data.InstanceRoot);

        Assert.Equal(new RecordFilter(MatchesNpcA, "npc-a.sql"), index.Queries.GetFilter().Value());
        Assert.Equal(["NpcA"], ListedNpcs(index));
    }

    [Fact]
    public async Task WhileARebuildRefills_TheRowsAlreadyBackAnswerThroughTheFilter()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-refill");
        using var gate = new GatedPluginAdapter();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");
        gate.ParkNextOpenOf("B.esp");

        Assert.Null(index.Queries.RebuildStore(GameRelease.Fallout4, data.InstanceRoot));
        await gate.WaitUntilParkedAsync();
        var midRefill = ListedNpcs(index);
        gate.Release();
        AwaitRefill(index);

        Assert.Equal(["NpcA"], midRefill);
        Assert.Equal(["NpcA"], ListedNpcs(index));
    }

    [Fact]
    public async Task AFilterClearedWhileARebuildRefills_LeavesTheRefilledRowsUnfiltered()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-clear");
        using var gate = new GatedPluginAdapter();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");
        gate.ParkNextOpenOf("B.esp");
        Assert.Null(index.Queries.RebuildStore(GameRelease.Fallout4, data.InstanceRoot));
        await gate.WaitUntilParkedAsync();

        var clear = Task.Run(index.ClearFilter);
        gate.Release();
        await clear.WaitAsync(Waits.Patience);
        AwaitRefill(index);

        Assert.Null(index.Queries.GetFilter().Value());
        Assert.Equal(["NpcA", "NpcB", "NpcOther"], ListedNpcs(index).Order());
    }

    [Fact]
    public void WhileARebuildReopensTheStore_AStatusReadNeverWaitsOnTheRecordFilter()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-status");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");
        var filtering = Stopwatch.StartNew();
        index.SetFilter(SlowlyMatchesNpcA, "slow.sql");
        var filterTakes = filtering.Elapsed;

        Assert.Null(index.Queries.RebuildStore(GameRelease.Fallout4, data.InstanceRoot));
        var longestRead = TimeSpan.Zero;
        var refilling = Stopwatch.StartNew();
        while (refilling.Elapsed < Waits.Patience)
        {
            var reading = Stopwatch.StartNew();
            var state = index.Status.State;
            if (reading.Elapsed > longestRead) longestRead = reading.Elapsed;
            if (state == LoadOrderState.Ready) break;
        }

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.True(longestRead < filterTakes / 2, $"The longest status read took {longestRead}; the filter takes {filterTakes}.");
    }

    [ForeignIndexHolderFact]
    public void AFilterClearedWhileARefusedRebuildLeavesNoStore_StaysClearedOnceTheIndexReopens()
    {
        List<ForeignIndexHolder> otherWindow = [];
        var notifications = new InMemoryNotificationPublisher();
        var armed = false;
        notifications.OnPublish = n =>
        {
            if (armed && otherWindow.Count == 0 && n is LoadOrderStatusNotification)
                otherWindow.Add(ForeignIndexHolder.Hold(IndexFiles.In(_fixture.InstanceRoot)));
        };
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");
        armed = true;

        try
        {
            Assert.NotNull(index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot));
            index.ClearFilter();
            otherWindow.ForEach(window => window.Dispose());
            index.NextSnapshot();

            Assert.Null(index.Queries.GetFilter().Value());
            Assert.Equal(["NpcBeforeRebuild"], ListedNpcs(index));
        }
        finally
        {
            otherWindow.ForEach(window => window.Dispose());
        }
    }

    [Fact]
    public void ARebuildWithNoLoadOrderHeld_LeavesTheStoreEmpty_AndReportsNothing()
    {
        Assert.Null(_index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot));

        Assert.Equal(0, _opens.OpenedTotal);
        Assert.Equal(LoadOrderState.None, _index.Status.State);
        Assert.Null(_index.Status.Message);
        Assert.Equal(IndexRefusal.NoLoadOrder, _index.Queries.GetFilter().Refused().Refusal);
    }

    [Fact]
    public async Task ARebuildRacingANewerArrival_EndsOnTheNewerLoadOrder()
    {
        using var data = new PluginFixtureBuilder("store-rebuild-race").WithPlugin("A.esp").WithPlugin("B.esp").Build();
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, data.DataFolder, [data.Plugins[0]], GameRelease.Fallout4, data.InstanceRoot);

        Assert.Null(index.Queries.RebuildStore(GameRelease.Fallout4, data.InstanceRoot));
        var version = holder.Apply(SnapshotPlugins.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));
        await gate.WaitUntilParkedAsync();
        gate.Release();
        index.AwaitVersion(version);
        AwaitRefill(index);

        Assert.Equal(version, index.Status.Version);
        Assert.NotNull(index.PluginResponseOf(data.Plugins[1].Key));
    }

    [Fact]
    public async Task AnArrivalOnceARebuildClosesTheStore_LeavesTheRefilledRowsInTheFileTheNextIndexOpens()
    {
        using var gate = new GatedPluginAdapter();
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, gate, notifications: notifications);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        PluginBinaries.Touch(_fixture.Plugins.Single().Path);
        gate.ParkNextOpenOf(Key.Name);
        Task? parked = null;
        bool? readWhileClosed = null;
        notifications.OnPublish = n =>
        {
            if (parked is not null || n is not LoadOrderStatusNotification { Status.State: LoadOrderState.None }) return;
            holder.Apply(holder.Current);
            parked = gate.WaitUntilParkedAsync();
            readWhileClosed = Waits.ReachedWithin(() => parked.IsCompleted, TimeSpan.FromSeconds(2));
        };

        Assert.Null(await Task.Run(() => index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot)));
        Assert.False(readWhileClosed);
        Assert.NotNull(parked);
        await parked.WaitAsync(Waits.Patience);
        gate.Release();
        AwaitRefill(index);
        index.Dispose();
        var opened = gate.OpenedTotal;
        using var next = Indexes.Open(holder, gate);
        next.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal(opened, gate.OpenedTotal);
        Assert.NotEmpty(next.ListedIn(Key));
    }

    [Fact]
    public void ARebuild_SeedsTheSequence_AtLeastTheValueAlreadyHandedOut()
    {
        Reconcile(_fixture.InstanceRoot);
        var priorSequence = _index.Sequence;
        Assert.True(priorSequence > 0, "sanity: indexing must have advanced the sequence past 0");

        Rebuilt(_index, _fixture.InstanceRoot);

        Assert.True(_index.Sequence > priorSequence,
            $"rebuilt sequence {_index.Sequence} regressed below the prior process value {priorSequence}");
    }

    [ForeignIndexHolderFact]
    public void ARebuildWhileAnotherProcessHoldsTheFile_IsRefused_AndLeavesTheFileInPlace()
    {
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder, _opens))
            earlier.Reconcile(earlierHolder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex = IndexFiles.In(_fixture.InstanceRoot);
        var bytesBeforeHold = File.ReadAllBytes(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex);
        StoreRebuildRefused? refusal;
        using (ForeignIndexHolder.Hold(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex))
            refusal = _index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);
        var bytesOnceTheHolderIsGoneAsWindowsLetsNothingReadAFileDuckDbHolds = File.ReadAllBytes(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex);

        Assert.Equal(StoreRebuildRefusal.HeldByAnotherWindow, refusal?.Refusal);
        Assert.Contains(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex, refusal?.Message);

        Assert.True(File.Exists(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex), "the file must still exist — a refusal must never delete it");
        Assert.Equal(bytesBeforeHold, bytesOnceTheHolderIsGoneAsWindowsLetsNothingReadAFileDuckDbHolds);
    }

    [ForeignIndexHolderFact]
    public void ARebuildRefusedBecauseAnotherProcessHoldsIt_LeavesTheStatusHeldElsewhere_NamingTheFile()
    {
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder, _opens))
            earlier.Reconcile(earlierHolder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var indexPath = IndexFiles.In(_fixture.InstanceRoot);
        using (ForeignIndexHolder.Hold(indexPath))
            _index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal(LoadOrderState.HeldElsewhere, _index.Status.State);
        Assert.Contains(indexPath, _index.Status.Message);
    }

    private static bool ReadMetARefusal(Exception ex) => ex is InvalidOperationException && ex.Message.StartsWith("Expected the Index to answer here", StringComparison.Ordinal);

    [Fact]
    public async Task ARebuildWithReadsInFlight_Completes_AndReadsThePluginAgain()
    {
        Reconcile(_fixture.InstanceRoot);
        using var rebuilding = new CancellationTokenSource();
        var answered = 0;
        var readers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
        {
            while (!rebuilding.IsCancellationRequested)
            {
                try
                {
                    if (_index.ListedIn(Key) is { Count: > 0 }) Interlocked.Increment(ref answered);
                }
                catch (Exception ex) when (ReadMetARefusal(ex))
                {
                }
            }
        })).ToArray();

        Assert.True(await Waits.Until(() => Volatile.Read(ref answered) > 0), "no read ever landed before the rebuild");
        Rebuilt(_index, _fixture.InstanceRoot);
        await rebuilding.CancelAsync();
        await Task.WhenAll(readers);
        Assert.Equal(2, _opens.OpenedTotal);
    }
}
