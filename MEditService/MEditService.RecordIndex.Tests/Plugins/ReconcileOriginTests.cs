using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReconcileOriginTests
{
    private static OpenedIndex OpenIndex(LoadOrderHolder holder) => Indexes.Open(holder);

    [Fact]
    public void Reconcile_WithOrigin_PluginCarriesCallerSuppliedOrigin()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => p with { Origin = "SomeMod" }).ToList();

        using var index = OpenIndex(holder);
        index.Reconcile(holder, fx.DataFolder, withOrigin, GameRelease.Fallout4);

        var opened = index.Queries.GetPlugins().Value().Single(row => row.Name == "A.esp");
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

        using var index = OpenIndex(holder);
        index.Reconcile(holder, fx.DataFolder, withOrigin, GameRelease.Fallout4);

        var result = index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value();

        var row = Assert.Single(result.Items);
        Assert.Equal("SomeMod", row.Origin);
    }
}
