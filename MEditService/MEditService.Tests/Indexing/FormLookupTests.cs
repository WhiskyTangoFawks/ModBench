using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

// ADR-0031: form_lookup population — mirrors FormReferencesTests.cs.
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

        // Two records and the plugin header (#631) — ADR-0031 keeps exactly one lookup row per
        // `records` row, and the header is one of those rows now. Written as the sum rather than as
        // "3" so the reason for each row stays visible.
        Assert.Equal(2 + 1, count);

        // ...and the header's is a real, resolvable row rather than filler that makes the count add
        // up: this is what lets Open Header's synthetic FormKey resolve like every other one.
        using var headerCmd = repo.Connection.CreateCommand();
        headerCmd.CommandText =
            "SELECT record_type, editor_id FROM form_lookup WHERE plugin = 'Lookup.esp' AND form_key = '000000:Lookup.esp'";
        using var reader = headerCmd.ExecuteReader();
        Assert.True(reader.Read(), "the plugin header must have its own form_lookup row");
        Assert.Equal(HeaderIndexer.RecordType, reader.GetString(0));
        Assert.True(reader.IsDBNull(1), "a header has no EditorID");
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
