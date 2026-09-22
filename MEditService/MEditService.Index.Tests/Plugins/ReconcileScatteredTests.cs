using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Plugins;

public sealed class ReconcileScatteredTests
{
    private static IndexProjector MakeManager(LoadOrderHolder holder) => Indexes.Open(holder);

    [Fact]
    public void Reconcile_PopulatesLoadOrderAndIndexesScatteredPlugins()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var manager = MakeManager(holder);
        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        Assert.Equal(1, reads.GetRecordTypeCounts(new PluginCopyKey("A.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(1, reads.GetRecordTypeCounts(new PluginCopyKey("B.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
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

        using var manager = MakeManager(holder);
        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        var winner = reads.GetDocument(shared.ToString());
        Assert.NotNull(winner);
        Assert.True(winner.IsWinner);
        Assert.Equal("Override.esp", winner.Plugin.Name);
    }

    [Fact]
    public void Reconcile_SameInstance_ReconcilesInPlace()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-replace")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        using var manager = MakeManager(holder);
        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.RequireReads();

        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Same(firstRepo, manager.RequireReads());
        Assert.NotEmpty(firstRepo.GetRecordTypeCounts(new PluginCopyKey("A.esp", "Data")));
    }

    // A single plugin whose binary data Mutagen can't parse (e.g.
    [Fact]
    public void Reconcile_OnePluginFailsToIndex_OthersStillLoadAndFailureIsReported()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-index-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("FromGood"))
            .WithPlugin("Bad.esp", mod => mod.Npcs.AddNew("FromBad"))
            .BuildScattered();

        using var adapter = new GatedPluginAdapter(poisonPlugin: "Bad.esp");
        using var manager = Indexes.Open(holder, adapter);

        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        Assert.Contains(manager.Status.Failures, f => f.Name == "Bad.esp");
        Assert.Equal(1, reads.GetRecordTypeCounts(new PluginCopyKey("Good.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(0, reads.GetRecordTypeCounts(new PluginCopyKey("Bad.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        // A plugin whose open threw never returned, so it is never listed as indexed.
        Assert.DoesNotContain(manager.Status.IndexedPlugins, p => p.Name == "Bad.esp");
    }
}
