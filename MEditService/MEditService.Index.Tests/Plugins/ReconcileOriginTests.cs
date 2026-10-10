using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

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
        index.Reconcile(holder, fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var opened = index.Records.GetPlugins().Value().Single(row => row.Plugin.Name == "A.esp");
        Assert.Equal("SomeMod", opened.Plugin.Origin);
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
        index.Reconcile(holder, fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var result = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value();

        var row = Assert.Single(result.Items);
        Assert.Equal("SomeMod", row.Origin);
    }
}
