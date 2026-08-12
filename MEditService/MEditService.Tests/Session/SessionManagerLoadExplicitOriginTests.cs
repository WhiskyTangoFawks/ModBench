using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Session;

// #269 / ADR-0036: the SessionManager-level LoadExplicit overload that carries a caller-supplied
// origin per plugin — the real, end-to-end path an MO2-backed session load uses. The origin-less
// overload (SessionManagerLoadExplicitTests) stays the only one every other ISessionManager test
// double implements; this exercises SessionManager's own override of the new one directly.
public sealed class SessionManagerLoadExplicitOriginTests
{
    private static SessionManager MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
    }

    [Fact]
    public void LoadExplicit_WithOrigin_PluginCarriesCallerSuppliedOrigin()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => (p.Name, p.Path, Origin: "SomeMod")).ToList();

        using var manager = MakeManager();
        ISessionManager sessionManager = manager;
        sessionManager.LoadExplicit(fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var plugin = manager.Session!.Plugins.Single(p => p.Name == "A.esp");
        Assert.Equal("SomeMod", plugin.Origin);
    }

    // #271 / ADR-0036: PluginMetadata.Origin alone (asserted above, since #269) never reached the
    // DuckDB index — SessionManager.IndexAndStore now threads it into Index(), so the indexed row
    // itself carries the real origin rather than silently falling back to the reserved default.
    [Fact]
    public void LoadExplicit_WithOrigin_IndexedRecordCarriesRealOrigin()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-origin-indexed")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => (p.Name, p.Path, Origin: "SomeMod")).ToList();

        using var manager = MakeManager();
        ISessionManager sessionManager = manager;
        sessionManager.LoadExplicit(fx.GameDirectory, withOrigin, GameRelease.Fallout4);

        var repository = (IRecordRepository)manager.Repository!;
        using var cmd = repository.Connection.CreateCommand();
        cmd.CommandText = "SELECT DISTINCT origin FROM npc_ WHERE plugin = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = "A.esp" });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read());
        Assert.Equal("SomeMod", reader.GetString(0));
    }
}
