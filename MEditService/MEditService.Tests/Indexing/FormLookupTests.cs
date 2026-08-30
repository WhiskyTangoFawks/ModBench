using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

// ADR-0031: form_lookup population — mirrors FormReferencesTests.cs, the AC's named prior art.
public class FormLookupTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static DuckDbRecordIndex OpenRepo()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static IModGetter LoadMod(string dataFolder, string pluginName)
    {
        var modPath = new ModPath(ModKey.FromFileName(pluginName), Path.Combine(dataFolder, pluginName));
        return Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
    }

    [Fact]
    public void Index_TwoRecords_PopulatesOneFormLookupRowEach()
    {
        using var fixture = new PluginFixtureBuilder("form-lookup-population")
            .WithPlugin("Lookup.esp", mod =>
            {
                mod.Npcs.AddNew("TestNPC01");
                mod.Races.AddNew("TestRace01");
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "Lookup.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM form_lookup WHERE plugin = 'Lookup.esp'";
        var count = (long)cmd.ExecuteScalar()!;

        Assert.Equal(2, count);
    }

    [Fact]
    public void Index_ReIndexSamePlugin_ReplacesRatherThanDuplicatesFormLookup()
    {
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-lookup-reindex")
            .WithPlugin("Reindex.esp", mod => npcFormKey = mod.Npcs.AddNew("TestNPC01").FormKey)
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "Reindex.esp");
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data")); // re-index same plugin
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM form_lookup WHERE form_key = $1 AND plugin = 'Reindex.esp'";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        var count = (long)cmd.ExecuteScalar()!;

        Assert.Equal(1, count);
    }
}
