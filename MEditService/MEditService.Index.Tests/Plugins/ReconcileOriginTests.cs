using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

public sealed class ReconcileOriginTests
{
    private static OpenedIndex MakeIndexer(LoadOrderHolder holder) => Indexes.Open(holder);

    [Fact]
    public void Reconcile_WithOrigin_PluginCarriesCallerSuppliedOrigin()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => p with { Origin = "SomeMod" }).ToList();

        using var manager = MakeIndexer(holder);
        OpenedIndex index = manager;
        index.Reconcile(holder, fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        var opened = reads.OpenedPlugins.Keys.Single(k => k.Name == "A.esp");
        Assert.Equal("SomeMod", opened.Origin);
    }

    [Fact]
    public void Reconcile_WithOrigin_IndexedRecordCarriesRealOrigin()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-origin-indexed")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => p with { Origin = "SomeMod" }).ToList();

        using var manager = MakeIndexer(holder);
        OpenedIndex index = manager;
        index.Reconcile(holder, fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        var result = reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Plugin: "A.esp", Limit: 10, Offset: 0));

        var row = Assert.Single(result.Items);
        Assert.Equal("SomeMod", row.Origin);
    }
}
