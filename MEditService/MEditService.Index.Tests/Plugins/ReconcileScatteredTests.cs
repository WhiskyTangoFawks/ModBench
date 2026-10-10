using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Plugins;

public sealed class ReconcileScatteredTests
{
    private static OpenedIndex OpenIndex(LoadOrderHolder holder) => Indexes.Open(holder);

    [Fact]
    public void Reconcile_PopulatesLoadOrderAndIndexesScatteredPlugins()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var index = OpenIndex(holder);
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(1, index.CountOf(new PluginAddress("A.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.Equal(1, index.CountOf(new PluginAddress("B.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public void Reconcile_CrossPluginOverride_WinnerIsHighestOrderPlugin()
    {
        var holder = new LoadOrderHolder();
        FormKey shared = default;
        using var fx = new PluginFixtureBuilder("sm-explicit-winner")
            .WithPlugin("Base.esm", mod => shared = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Override.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First().DeepCopy());
            })
            .BuildScattered();

        using var index = OpenIndex(holder);
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var winner = index.Records.GetRecord(shared.ToString()).Value();
        Assert.NotNull(winner);
        Assert.True(winner.IsWinner);
        Assert.Equal("Override.esp", winner.Plugin);
    }

    [Fact]
    public void Reconcile_SameInstance_ReconcilesInPlace()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-replace")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var opens = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, opens);
        index.Reconcile(holder, fx.GameDirectory, [fx.Plugins[0]], GameRelease.Fallout4);

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(["A.esp", "B.esp"], opens.Opened);
        Assert.Equal(1, index.CountOf(new PluginAddress("A.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public void Reconcile_OnePluginFailsToIndex_OthersStillLoad_AndTheFailureIsReportedWithoutListingItAsIndexed()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-index-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("FromGood"))
            .WithPlugin("Bad.esp", mod => mod.Npcs.AddNew("FromBad"))
            .BuildScattered();

        using var adapter = new GatedPluginAdapter(poisonPlugin: "Bad.esp");
        using var index = Indexes.Open(holder, adapter);

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Contains(index.Status.Failures, f => f.Name == "Bad.esp");
        Assert.Equal(1, index.CountOf(new PluginAddress("Good.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.Equal(0, index.CountOf(new PluginAddress("Bad.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "Bad.esp");
    }
}
