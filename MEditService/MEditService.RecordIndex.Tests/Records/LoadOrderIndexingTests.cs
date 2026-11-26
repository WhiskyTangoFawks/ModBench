using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class LoadOrderIndexingTests
{
    private static ScatteredFixtureData TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("B.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("A.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .BuildScattered();

    private static void Reconcile(OpenedIndex indexer, LoadOrderHolder holder, ScatteredFixtureData fx, IReadOnlyList<LoadOrderEntry>? plugins = null) =>
        indexer.Reconcile(holder, fx.DataFolder, plugins ?? fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);

    private static string SharedNpc(OpenedIndex indexer) =>
        indexer.Queries.GetRecords(["npc_"], new PluginAddress("A.esm", PluginOrigin.DataDirectory), search: null, limit: 10, offset: 0).Value()
            .Items.Single().FormKey;

    private static string WinnerOf(OpenedIndex indexer, string formKey) =>
        indexer.StackOf(formKey).Single(copy => copy.IsWinner).Plugin;

    private static IReadOnlyDictionary<PluginAddress, PluginResponse> OpenedPlugins(OpenedIndex indexer) =>
        indexer.Queries.GetPlugins().Value().ToDictionary(row => row.KeyOf(), row => row, PluginAddress.Comparer);

    [Fact]
    public void AReDerivationAfterASnapshotMovedTheWinners_TakesItsWinnersFromTheHolder_NotFromThePluginsItHasOpen()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-winners-from-holder");
        using var indexer = Indexes.Open(holder);
        Reconcile(indexer, holder, fx);
        var npc = SharedNpc(indexer);
        Assert.Equal("B.esp", WinnerOf(indexer, npc));

        var b = fx.Plugins.Single(p => p.Name == "B.esp");
        Reconcile(indexer, holder, fx, [.. fx.Plugins.Select(p => p.Name == "B.esp" ? p with { Winning = false } : p)]);
        PluginBinaries.Touch(b.Path);
        indexer.NextCheck();

        Assert.Equal("A.esm", WinnerOf(indexer, npc));
    }

    [Fact]
    public void TheReads_CarryTheHeaderFlagsAndMastersOfThePluginsTheIndexOpened()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-opened-content");
        using var indexer = Indexes.Open(holder);

        Reconcile(indexer, holder, fx);

        var opened = OpenedPlugins(indexer);
        var patch = opened[fx.Plugins.Single(c => c.Name == "B.esp").Key];
        Assert.Equal(["A.esm"], patch.Masters);
        Assert.False(patch.IsMaster);
        Assert.True(opened[fx.Plugins.Single(c => c.Name == "A.esm").Key].IsMaster);
    }

    [Fact]
    public void AValidationThatReDerivesTwoPlugins_AdvancesTheSequenceExactlyOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-one-advance");
        using var indexer = Indexes.Open(holder);
        Reconcile(indexer, holder, fx);
        PluginBinaries.Touch(fx.Plugins[0].Path);
        PluginBinaries.Touch(fx.Plugins[1].Path);
        var before = indexer.Sequence;

        indexer.NextCheckUntil(() => indexer.Sequence > before, "the sequence moving");

        Assert.Equal(before + 1, indexer.Sequence);
    }

    [Fact]
    public void TheActivePlugins_AreCountedBesideEveryPlugin()
    {
        using var data = new PluginFixtureBuilder("status-active")
            .WithPlugin("A.esp").WithPlugin("B.esp", enabled: false).WithPlugin("C.esp")
            .Build();
        using var index = Indexes.Reconciled(data);

        Assert.Equal(3, index.Status.TotalPlugins);
        Assert.Equal(2, index.Status.ActivePlugins);
    }
}
