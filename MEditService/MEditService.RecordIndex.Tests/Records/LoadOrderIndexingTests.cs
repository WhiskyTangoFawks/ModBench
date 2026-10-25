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
        indexer.NextSnapshot();

        Assert.Equal("A.esm", WinnerOf(indexer, npc));
    }

    [Fact]
    public void TheIndexHoldsExactlyTheLoadOrdersPlugins()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-registrations");
        using var indexer = Indexes.Open(holder);

        Reconcile(indexer, holder, fx);

        Assert.All(fx.Plugins, plugin => Assert.NotEmpty(indexer.ListedIn(plugin.Key)));
        Assert.Equal(
            fx.Plugins.Select(c => c.Key).OrderBy(k => k.Name, StringComparer.Ordinal),
            OpenedPlugins(indexer).Keys.OrderBy(k => k.Name, StringComparer.Ordinal));
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
    public void TheReads_OmitAPluginTheIndexCouldNotOpen()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-unopenable-content");
        using var indexer = Indexes.Open(holder);
        var gone = new LoadOrderEntry("Gone.esp", Path.Combine(fx.DataFolder, "Gone.esp"), "SomeMod", 9, true, true);

        Reconcile(indexer, holder, fx, [.. fx.Plugins, gone]);

        var opened = OpenedPlugins(indexer);
        Assert.DoesNotContain(new PluginAddress("Gone.esp", "SomeMod"), opened.Keys);
        Assert.Contains(fx.Plugins.Single(c => c.Name == "A.esm").Key, opened.Keys);
    }

    [Theory]
    [InlineData("B.esp")]
    [InlineData("A.esm", "B.esp")]
    public void AValidationThatReDerivesPlugins_AdvancesTheSequenceExactlyOnce(params string[] touched)
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProvidersOfSharedNpcDefinedInAEsmAndOverriddenInBEsp("indexer-one-advance");
        using var indexer = Indexes.Open(holder);
        Reconcile(indexer, holder, fx);
        fx.Plugins.Where(p => touched.Contains(p.Name)).ToList().ForEach(p => PluginBinaries.Touch(p.Path));
        var before = indexer.Sequence;

        indexer.NextSnapshot();

        Assert.Equal(before + 1, indexer.Sequence);
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
        using var indexer = Indexes.Open(holder);
        Reconcile(indexer, holder, fx, [.. fx.Plugins.Where(p => p.Name == "A.esm")]);
        indexer.SetFilter("SELECT form_key FROM npc_", "filter.sql");

        Reconcile(indexer, holder, fx);

        var matched = indexer.Queries.GetRecords(
            ["npc_"], new PluginAddress("C.esp", PluginOrigin.DataDirectory), search: null, limit: 10, offset: 0).Value();
        Assert.Equal([charlieNpcOwnedNotOverriddenFromASoTheFilterCouldNotAlreadyHaveListedItsFormKey], matched.Items.Select(i => i.EditorId));
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
