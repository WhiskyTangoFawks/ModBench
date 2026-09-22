using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

// ADR-0012: the IndexProjector-level Reconcile call that carries a caller-supplied
// origin per plugin — the real, end-to-end path an MO2-backed reconcile uses.
public sealed class ReconcileOriginTests
{
    private static IndexProjector MakeManager(LoadOrderHolder holder) => Indexes.Open(holder);

    [Fact]
    public void Reconcile_WithOrigin_PluginCarriesCallerSuppliedOrigin()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => p with { Origin = "SomeMod" }).ToList();

        using var manager = MakeManager(holder);
        IndexProjector index = manager;
        index.Reconcile(holder, fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        var opened = reads.OpenedCopies.Keys.Single(k => k.Name == "A.esp");
        Assert.Equal("SomeMod", opened.Origin);
    }

    // ADR-0012: PluginMetadata.Origin alone (asserted above) is not enough — the indexed row
    // itself must carry the real origin rather than silently falling back to the reserved default.
    [Fact]
    public void Reconcile_WithOrigin_IndexedRecordCarriesRealOrigin()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-origin-indexed")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => p with { Origin = "SomeMod" }).ToList();

        using var manager = MakeManager(holder);
        IndexProjector index = manager;
        index.Reconcile(holder, fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        var result = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "A.esp", Limit: 10, Offset: 0));

        var row = Assert.Single(result.Items);
        Assert.Equal("SomeMod", row.Origin);
    }
}
