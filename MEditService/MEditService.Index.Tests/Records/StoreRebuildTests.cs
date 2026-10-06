using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

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

    private PluginAddress Key => _fixture.Plugins.Single().KeyOf();

    private void Reconcile(string? instanceRoot) =>
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, instanceRoot);

    [Fact]
    public void AnEmptySnapshot_ReconcilesToAnIndexThatAnswersNothing()
    {
        _index.Reconcile(_holder, _fixture.GameDirectory, [], GameRelease.Fallout4);

        var result = _index.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 1, Offset: 0));
        Assert.Equal(0, result.Total);
    }

    [Fact]
    public void WithNoInstanceRoot_NothingIsKeptBetweenIndexes()
    {
        Reconcile(instanceRoot: null);
        Assert.Equal(1, _opens.OpenedTotal);
        _index.Dispose();

        using var next = Indexes.Open(_holder, _opens);
        next.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(2, _opens.OpenedTotal);
    }

    [Fact]
    public async Task Rebuild_ReadsThePluginAgain_AgainstTheLoadOrderHeld()
    {
        Reconcile(_fixture.InstanceRoot);
        Assert.Equal(1, _opens.OpenedTotal);
        var held = _holder.Version;

        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot).Refill;

        Assert.Equal(2, _opens.OpenedTotal);
        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
        Assert.Equal(held, _index.Status.Version);
        Assert.NotEmpty(_index.RequireReads().GetDocuments(Key));
    }

    private const string MatchesNpcA = "SELECT form_key FROM npc_ WHERE editor_id = 'NpcA'";

    private static PluginFixtureData NpcAAndNpcOtherInAespAndNpcBInBespFixture(string name) => new PluginFixtureBuilder(name)
        .WithPlugin("A.esp", mod => { mod.Npcs.AddNew("NpcA"); mod.Npcs.AddNew("NpcOther"); })
        .WithPlugin("B.esp", mod => mod.Npcs.AddNew("NpcB"))
        .Build();

    private static string[] ListedNpcs(OpenedIndex index) =>
        [.. index.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Items.Select(i => i.EditorId ?? "")];

    [Fact]
    public async Task Rebuild_KeepsTheRecordFilter_AndTheRefilledRowsAnswerThroughIt()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-kept");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, _opens);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");

        await index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot).Refill;

        Assert.Equal((MatchesNpcA, "npc-a.sql"), index.ActiveFilter);
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

        var refill = index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot).Refill;
        await gate.WaitUntilParkedAsync();
        var midRefill = ListedNpcs(index);
        gate.Release();
        await refill;

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
        var refill = index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot).Refill;
        await gate.WaitUntilParkedAsync();

        var clear = Task.Run(index.ClearFilter);
        gate.Release();
        await Task.WhenAll(refill, clear).WaitAsync(Waits.Patience);

        Assert.Null(index.ActiveFilter);
        Assert.Equal(["NpcA", "NpcB", "NpcOther"], ListedNpcs(index).Order());
    }

    [ForeignIndexHolderFact]
    public void AFilterKeptThroughARefusedRebuild_StillClears()
    {
        using var otherWindow = new HoldsTheFileOnceTheRebuildClosesTheStore(() => IndexFiles.In(_fixture.InstanceRoot));
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: otherWindow);
        index.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");
        otherWindow.Armed = true;

        var rebuild = index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);
        Assert.NotNull(rebuild.Refusal);
        Assert.NotNull(index.ActiveFilter);
        index.ClearFilter();

        Assert.Null(index.ActiveFilter);
    }

    private sealed class HoldsTheFileOnceTheRebuildClosesTheStore(Func<string> indexPath) : INotificationPublisher, IDisposable
    {
        private ForeignIndexHolder? _holder;

        public bool Armed { get; set; }

        public void Publish(INotification notification)
        {
            if (Armed && _holder is null && notification is LoadOrderStatusNotification)
                _holder = ForeignIndexHolder.Hold(indexPath());
        }

        public void Dispose() => _holder?.Dispose();
    }

    [Fact]
    public async Task Rebuild_WithNoLoadOrderHeld_LeavesTheStoreEmpty_AndReportsNothing()
    {
        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot).Refill;

        Assert.Equal(0, _opens.OpenedTotal);
        Assert.Equal(LoadOrderState.None, _index.Status.State);
        Assert.Null(_index.Status.Message);
        Assert.Throws<NoLoadOrderException>(() => _index.RequireReads());
    }

    [Fact]
    public async Task ARebuildRacingANewerArrival_EndsOnTheNewerLoadOrder()
    {
        using var data = new PluginFixtureBuilder("store-rebuild-race").WithPlugin("A.esp").WithPlugin("B.esp").Build();
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, data.DataFolder, [data.Plugins[0]], GameRelease.Fallout4, data.InstanceRoot);

        var refill = index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot).Refill;
        var version = holder.Apply(LoadOrderArrival.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));
        await gate.WaitUntilParkedAsync();
        gate.Release();
        await refill.WaitAsync(Waits.Patience);
        index.AwaitVersion(version);

        Assert.Equal(version, index.Status.Version);
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.True(index.RequireReads().OpenedPlugins.ContainsKey(data.Plugins[1].KeyOf()), "the rebuild ended on the newer load order");
    }

    [Fact]
    public async Task Rebuild_SeedsTheSequence_AtLeastTheValueAlreadyHandedOut()
    {
        Reconcile(_fixture.InstanceRoot);
        var priorSequence = _index.Sequence;
        Assert.True(priorSequence > 0, "sanity: indexing must have advanced the sequence past 0");

        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot).Refill;

        Assert.True(_index.Sequence > priorSequence,
            $"rebuilt sequence {_index.Sequence} regressed below the prior process value {priorSequence}");
    }

    [ForeignIndexHolderFact]
    public void Rebuild_RefusesAndLeavesTheFileInPlace_WhenAnotherProcessHoldsIt()
    {
        var earlierHolder = new LoadOrderHolder();
        using (var earlier = Indexes.Open(earlierHolder, _opens))
            earlier.Reconcile(earlierHolder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex = IndexFiles.In(_fixture.InstanceRoot);
        var bytesBeforeHold = File.ReadAllBytes(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex);
        using var otherWindow = ForeignIndexHolder.Hold(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex);

        var rebuild = _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Contains(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex, rebuild.Refusal);

        Assert.True(File.Exists(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex), "the file must still exist — a refusal must never delete it");
        Assert.Equal(bytesBeforeHold, File.ReadAllBytes(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex));
    }

    private static bool ScopeClosedUnderTheReadSoTheAnswerIsNoStore(Exception ex) =>
        ex is ObjectDisposedException or InvalidOperationException or NoLoadOrderException;

    [Fact]
    public async Task ARebuildWithReadsInFlight_Completes_WhereDisposingTheStoreUnderAReadWouldCrashNatively()
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
                    if (_index.RequireReads().GetDocuments(Key) is { Count: > 0 }) Interlocked.Increment(ref answered);
                }
                catch (Exception ex) when (ScopeClosedUnderTheReadSoTheAnswerIsNoStore(ex))
                {
                }
            }
        })).ToArray();

        Assert.True(await Waits.Until(() => Volatile.Read(ref answered) > 0), "no read ever landed before the rebuild");
        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot).Refill;
        await rebuilding.CancelAsync();
        await Task.WhenAll(readers);
        Assert.Equal(2, _opens.OpenedTotal);
    }
}
