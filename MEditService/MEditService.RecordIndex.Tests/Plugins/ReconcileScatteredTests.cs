using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReconcileScatteredTests
{
    [Fact]
    public void PluginsScatteredAcrossModFolders_AreEachIndexed()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var index = Indexes.Open(holder);
        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(1, index.CountOf(new PluginAddress("A.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.Equal(1, index.CountOf(new PluginAddress("B.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public void ALaterSnapshotOfTheSameInstance_ReadsOnlyThePluginItAdds()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-replace")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var opens = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, opens);
        index.Reconcile(holder, fx.DataFolder, [fx.Plugins[0]], GameRelease.Fallout4);

        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(["A.esp", "B.esp"], opens.Opened);
        Assert.Equal(1, index.CountOf(new PluginAddress("A.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public void APluginThatFailsToRead_IsAFailure_NotListedAsIndexed_AndTheRestLoad()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-index-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("FromGood"))
            .WithPlugin("Bad.esp", mod => mod.Npcs.AddNew("FromBad"))
            .BuildScattered();

        using var adapter = new GatedPluginAdapter(poisonPlugin: "Bad.esp");
        using var index = Indexes.Open(holder, adapter);

        index.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);

        Assert.Contains(index.Status.Failures, f => f.Name == "Bad.esp");
        Assert.Equal(1, index.CountOf(new PluginAddress("Good.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.Equal(0, index.CountOf(new PluginAddress("Bad.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "Bad.esp");
    }
}
