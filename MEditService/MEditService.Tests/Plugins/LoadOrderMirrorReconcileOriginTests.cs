using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// #269 / ADR-0036: the LoadOrderMirror-level Reconcile call that carries a caller-supplied
// origin per plugin — the real, end-to-end path an MO2-backed reconcile uses.
public sealed class LoadOrderMirrorReconcileOriginTests
{
    private static LoadOrderMirror MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new LoadOrderMirror(factory);
    }

    [Fact]
    public void Reconcile_WithOrigin_PluginCarriesCallerSuppliedOrigin()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => p with { Origin = "SomeMod" }).ToList();

        using var manager = MakeManager();
        ILoadOrderMirror mirror = manager;
        mirror.Reconcile(fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var plugin = manager.LoadOrder!.Plugins.Single(p => p.Name == "A.esp");
        Assert.Equal("SomeMod", plugin.Origin);
    }

    // #271 / ADR-0036: PluginMetadata.Origin alone (asserted above, since #269) never reached the
    // DuckDB index — LoadOrderMirror.IndexAndStore now threads it into Index(), so the indexed row
    // itself carries the real origin rather than silently falling back to the reserved default.
    [Fact]
    public void Reconcile_WithOrigin_IndexedRecordCarriesRealOrigin()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-origin-indexed")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => p with { Origin = "SomeMod" }).ToList();

        using var manager = MakeManager();
        ILoadOrderMirror mirror = manager;
        mirror.Reconcile(fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var result = manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey("A.esp"), Limit: 10, Offset: 0));

        var row = Assert.Single(result.Items);
        Assert.Equal("SomeMod", row.Origin);
    }
}
