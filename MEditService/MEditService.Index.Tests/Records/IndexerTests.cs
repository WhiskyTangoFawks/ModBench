using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class IndexerTests
{
    private static Indexer MakeIndexer(LoadOrderHolder holder) => Indexes.Open(holder);

    private static (Indexer Index, GatedPluginAdapter Opens) MakeCountingIndexer(LoadOrderHolder holder)
    {
        var opens = new GatedPluginAdapter();
        return (Indexes.Open(holder, opens), opens);
    }

    private static ScatteredFixtureData TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("B.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("A.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .BuildScattered();

    private static LoadOrderSnapshot Snapshot(ScatteredFixtureData fx, IReadOnlyList<LoadOrderEntry>? plugins = null) =>
        SnapshotPlugins.Snapshot(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, plugins ?? fx.Plugins);

    private static void ReconcileInTheLoadOrderEndpointsOrder(Indexer indexer, LoadOrderHolder holder, LoadOrderSnapshot snapshot) =>
        indexer.Reconcile(snapshot, holder.Apply(snapshot));

    private static void ReDeriveByTouchingTheBytesThenValidating(Indexer indexer, LoadOrderEntry entry)
    {
        PluginBinaries.Touch(entry.Path);
        Assert.True(indexer.Revalidate());
    }

    private static string SharedNpc(Indexer indexer) =>
        indexer.RequireReads()
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "A.esm", Limit: 10, Offset: 0))
            .Items.Single().FormKey;

    private static string? WinnerOf(Indexer indexer, string formKey)
    {
        var stack = indexer.RequireReads().GetOverrideStack(formKey)
            ?? throw new InvalidOperationException($"Expected {formKey} to resolve to an override stack.");
        return stack.Entries.Single(e => e.IsWinner).Plugin.Name;
    }

    [Fact]
    public async Task ASweepBetweenSnapshots_TakesItsWinnersFromTheHolder_NotFromThePluginsItHasOpen()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-winners-from-holder");
        using var indexer = MakeIndexer(holder);
        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, Snapshot(fx));
        var npc = SharedNpc(indexer);
        Assert.Equal("B.esp", WinnerOf(indexer, npc));

        var b = fx.Plugins.Single(p => p.Name == "B.esp");
        holder.Apply(Snapshot(fx, [.. fx.Plugins.Select(p => p.Name == "B.esp" ? p with { Winning = false } : p)]));
        ReDeriveByTouchingTheBytesThenValidating(indexer, b);

        Assert.Equal("A.esm", WinnerOf(indexer, npc));
    }

    [Fact]
    public void Reconcile_RegistersExactlyTheLoadOrdersPlugins()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-registrations");
        using var indexer = MakeIndexer(holder);
        var snapshot = Snapshot(fx);

        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, snapshot);

        Assert.All(snapshot.Plugins, plugin => Assert.NotEmpty(indexer.RequireReads().GetDocuments(plugin.Key)));
        Assert.Equal(
            snapshot.Plugins.Select(c => c.Key).OrderBy(k => k.Name, StringComparer.Ordinal),
            indexer.RequireReads().OpenedPlugins.Keys.OrderBy(k => k.Name, StringComparer.Ordinal));
    }

    [Fact]
    public void TheReads_CarryTheHeaderFlagsMastersAndRecordCountOfThePluginsTheIndexOpened()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-opened-content");
        using var indexer = MakeIndexer(holder);
        var snapshot = Snapshot(fx);

        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, snapshot);

        var opened = indexer.RequireReads().OpenedPlugins;
        var patch = opened[snapshot.Plugins.Single(c => c.Name == "B.esp").Key];
        Assert.Equal(["A.esm"], patch.Masters);
        Assert.Equal(1, patch.RecordCount);
        Assert.False(patch.IsMaster);
        Assert.True(opened[snapshot.Plugins.Single(c => c.Name == "A.esm").Key].IsMaster);
    }

    [Fact]
    public void TheReads_OmitAPluginTheIndexCouldNotOpen()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-unopenable-content");
        using var indexer = MakeIndexer(holder);
        var gone = new LoadOrderEntry("Gone.esp", Path.Combine(fx.GameDirectory, "Gone.esp"), "SomeMod", 9, true, true);
        var snapshot = Snapshot(fx, [.. fx.Plugins, gone]);

        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, snapshot);

        var opened = indexer.RequireReads().OpenedPlugins;
        Assert.DoesNotContain(new PluginAddress("Gone.esp", "SomeMod"), opened.Keys);
        Assert.Contains(snapshot.Plugins.Single(c => c.Name == "A.esm").Key, opened.Keys);
    }

    [Fact]
    public async Task AWholePluginProjection_AdvancesTheSequenceExactlyOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-one-advance");
        using var indexer = MakeIndexer(holder);
        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, Snapshot(fx));
        PluginBinaries.Touch(fx.Plugins.Single(p => p.Name == "B.esp").Path);
        var before = indexer.Sequence;

        Assert.True(indexer.Revalidate());

        Assert.Equal(before + 1, indexer.Sequence);
    }

    [Fact]
    public void AValidationOfSeveralPlugins_AdvancesTheSequenceOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-batch");
        using var indexer = MakeIndexer(holder);
        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, Snapshot(fx));
        foreach (var entry in fx.Plugins) PluginBinaries.Touch(entry.Path);
        var before = indexer.Sequence;

        indexer.NextSnapshot();

        Assert.Equal(before + 1, indexer.Sequence);
    }

    [Fact]
    public void AnArrivingPlugin_ReappliesTheFilter_SoItsRowsAnswerThroughIt()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-arriving-filter");
        using var indexer = MakeIndexer(holder);
        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, Snapshot(fx, [fx.Plugins[0]]));
        indexer.SetFilter("SELECT form_key FROM records", "filter.sql");

        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, Snapshot(fx));

        var arrived = fx.Plugins[1];
        var rows = indexer.RequireReads().Search(new RecordQuery(
            Plugin: arrived.Name, Origin: arrived.Origin, Limit: 10, Offset: 0));
        Assert.NotEmpty(rows.Items);
    }

    [Fact]
    public void AFilteredReadAfterAProjection_ReflectsTheFilter_WithNoCallerReapplyingIt()
    {
        var holder = new LoadOrderHolder();
        const string charlieNpcOwnedNotOverriddenFromASoTheFilterCouldNotAlreadyHaveListedItsFormKey = "CharlieNpc";
        using var fx = new PluginFixtureBuilder("indexer-filter")
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew(charlieNpcOwnedNotOverriddenFromASoTheFilterCouldNotAlreadyHaveListedItsFormKey))
            .BuildScattered();
        using var indexer = MakeIndexer(holder);
        var onlyA = fx.Plugins.Where(p => p.Name == "A.esm").ToList();
        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, Snapshot(fx, onlyA));
        indexer.SetFilter("SELECT form_key FROM npc_", "filter.sql");

        ReconcileInTheLoadOrderEndpointsOrder(indexer, holder, Snapshot(fx));

        var matched = indexer.RequireReads()
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "C.esp", Origin: PluginOrigin.DataDirectory, Limit: 10, Offset: 0));
        Assert.Equal([charlieNpcOwnedNotOverriddenFromASoTheFilterCouldNotAlreadyHaveListedItsFormKey], matched.Items.Select(i => i.EditorId));
    }

    [Fact]
    public void Status_CountsTheActivePlugins_BesideEveryPlugin()
    {
        using var data = new PluginFixtureBuilder("status-active")
            .WithPlugin("A.esp").WithPlugin("B.esp", enabled: false).WithPlugin("C.esp")
            .Build();
        using var index = Indexes.Reconciled(data);

        Assert.Equal(3, index.Status.TotalPlugins);
        Assert.Equal(2, index.Status.ActivePlugins);
    }
}
