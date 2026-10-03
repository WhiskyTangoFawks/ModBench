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
    private readonly Indexer _index;

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

        var result = _index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 1, Offset: 0));
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

        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);

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

    private static string[] ListedNpcs(Indexer index) =>
        [.. index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Items.Select(i => i.EditorId ?? "")];

    [Fact]
    public async Task Rebuild_KeepsTheRecordFilter_AndTheRefilledRowsAnswerThroughIt()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-kept");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, _opens);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        index.SetFilter(MatchesNpcA, "npc-a.sql");

        await index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot);

        Assert.Equal((MatchesNpcA, "npc-a.sql"), index.ActiveFilter);
        Assert.Equal(["NpcA"], ListedNpcs(index));
    }

    [Fact]
    public async Task WhileARebuildRefills_TheRowsAlreadyBackAnswerThroughTheFilter()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-refill");
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        var holder = new LoadOrderHolder();
        using var index = new Indexer(holder, gate, SharedSchemaReflector.Instance);
        var onlyA = IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, [data.Plugins[0]]);
        index.Reconcile(onlyA, holder.Apply(onlyA));
        index.SetFilter(MatchesNpcA, "npc-a.sql");
        holder.Apply(IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins));

        var refill = index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot);
        await gate.WaitUntilParkedAsync();
        var midRefill = ListedNpcs(index);
        gate.Release();
        await refill;

        Assert.Equal(["NpcA"], midRefill);
        Assert.Equal(["NpcA"], ListedNpcs(index));
    }

    [Fact]
    public async Task AFilterKeptThroughARebuild_ClearsBeforeTheRefillOpensAStore()
    {
        using var data = NpcAAndNpcOtherInAespAndNpcBInBespFixture("store-rebuild-filter-clear");
        var refills = new HeldBackScheduler();
        var holder = new LoadOrderHolder();
        using var index = new Indexer(holder, _opens, SharedSchemaReflector.Instance, refillScheduler: refills);
        var snapshot = IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);
        index.Reconcile(snapshot, holder.Apply(snapshot));
        index.SetFilter(MatchesNpcA, "npc-a.sql");
        var refill = index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot);

        index.ClearFilter();
        refills.RunHeldBack();
        await refill;

        Assert.Null(index.ActiveFilter);
        Assert.Equal(["NpcA", "NpcB", "NpcOther"], ListedNpcs(index).Order());
    }

    [Fact]
    public async Task Rebuild_WithNoLoadOrderHeld_LeavesTheStoreEmpty_AndReportsNothing()
    {
        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal(0, _opens.OpenedTotal);
        Assert.Equal(LoadOrderState.None, _index.Status.State);
        Assert.Null(_index.Status.Message);
        Assert.Throws<NoLoadOrderException>(() => _index.RequireReads());
    }

    [Fact]
    public async Task ARefill_FillsTheLoadOrderHeldWhenItRuns_NotTheOneHeldWhenTheRebuildStarted_EvenWhenTheRefillCancelledThatArrivalsOwnReconcile()
    {
        using var data = new PluginFixtureBuilder("store-rebuild-race").WithPlugin("A.esp").WithPlugin("B.esp").Build();
        using var gate = new GatedPluginAdapter(gateBefore: "B.esp");
        var refills = new HeldBackScheduler();
        var holder = new LoadOrderHolder();
        using var index = new Indexer(holder, gate, SharedSchemaReflector.Instance, refillScheduler: refills);
        var onlyA = IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, [data.Plugins[0]]);
        index.Reconcile(onlyA, holder.Apply(onlyA));

        var refill = index.RebuildStore(GameRelease.Fallout4, data.InstanceRoot);
        var both = IndexReconcile.Snapshot(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, data.Plugins);
        var version = holder.Apply(both);
        var arrival = Task.Run(() => index.Reconcile(both, version));
        await gate.WaitUntilParkedAsync();
        var refilling = Task.Run(refills.RunHeldBack);
        gate.Release();
        await Task.WhenAll(arrival, refilling, refill);

        Assert.Equal(version, index.Status.Version);
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.True(index.RequireReads().OpenedPlugins.ContainsKey(data.Plugins[1].KeyOf()), "the refill filled the load order held when it ran");
    }

    [Fact]
    public async Task Rebuild_SeedsTheSequence_AtLeastTheValueAlreadyHandedOut()
    {
        Reconcile(_fixture.InstanceRoot);
        var priorSequence = _index.Sequence;
        Assert.True(priorSequence > 0, "sanity: indexing must have advanced the sequence past 0");

        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.True(_index.Sequence > priorSequence,
            $"rebuilt sequence {_index.Sequence} regressed below the prior process value {priorSequence}");
    }

    [ForeignIndexHolderFact]
    public void Rebuild_RefusesAndLeavesTheFileInPlace_WhenAnotherProcessHoldsIt()
    {
        using (var earlier = Indexes.Open(new LoadOrderHolder(), _opens))
            earlier.Reconcile(new LoadOrderHolder(), _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex = IndexFiles.In(_fixture.InstanceRoot);
        var bytesBeforeHold = File.ReadAllBytes(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex);
        using var otherWindow = ForeignIndexHolder.Hold(indexPathWhoseOpenFileDeletionSucceedsOnPosixAndWouldDestroyTheLiveIndex);

        Assert.Throws<IndexHeldElsewhereException>(() => { _ = _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot); });

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
        await _index.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot);
        await rebuilding.CancelAsync();
        await Task.WhenAll(readers);
        Assert.Equal(2, _opens.OpenedTotal);
    }
}
