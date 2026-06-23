using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

public class FormReferencesTests
{
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);

    private static DuckDbRecordRepository OpenRepo()
    {
        var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        return repo;
    }

    private static IModGetter LoadMod(string dataFolder, string pluginName)
    {
        var modPath = new ModPath(ModKey.FromFileName(pluginName), Path.Combine(dataFolder, pluginName));
        return Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
    }

    [Fact]
    public void Index_ScalarFormKeyField_IsIndexedInFormReferences()
    {
        FormKey raceFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-scalar")
            .WithPlugin("References.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace01");
                raceFormKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC01");
                npcFormKey = npc.FormKey;
                npc.Race.SetTo(race.FormKey);
            })
            .Build();

        using var repo = OpenRepo();
        repo.Index(LoadMod(fixture.DataFolder, "References.esp"), 0);
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path, record_type FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath, string RecordType)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));

        var raceRow = rows.FirstOrDefault(r => r.FieldPath == "race");
        Assert.NotEqual(default, raceRow);
        Assert.Equal(raceFormKey.ToString(), raceRow.Target);
        Assert.Equal("npc_", raceRow.RecordType);
    }

    [Fact]
    public void Index_NoFormLinkFieldsSet_FormReferencesIsEmpty()
    {
        using var fixture = new PluginFixtureBuilder("form-refs-empty")
            .WithPlugin("NoRefs.esp", mod =>
            {
                mod.Npcs.AddNew("BareNPC");
            })
            .Build();

        using var repo = OpenRepo();
        repo.Index(LoadMod(fixture.DataFolder, "NoRefs.esp"), 0);
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM form_references";
        var count = (long)cmd.ExecuteScalar()!;

        Assert.Equal(0, count);
    }

    [Fact]
    public void Index_ReIndexSamePlugin_ReplacesRatherThanDuplicates()
    {
        FormKey raceFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-reindex")
            .WithPlugin("Reindex.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace01");
                raceFormKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC01");
                npc.Race.SetTo(race.FormKey);
            })
            .Build();

        using var repo = OpenRepo();
        var mod = LoadMod(fixture.DataFolder, "Reindex.esp");
        repo.Index(mod, 0);
        repo.Index(mod, 0);  // re-index same plugin
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM form_references WHERE source_plugin = 'Reindex.esp'";
        var count = (long)cmd.ExecuteScalar()!;

        // The race row + any other FormLinks on the NPC — should be exactly the same as after first index
        // Specifically, the Race entry must not be duplicated
        using var raceCmd = repo.Connection.CreateCommand();
        raceCmd.CommandText = "SELECT COUNT(*) FROM form_references WHERE field_path = 'race' AND source_plugin = 'Reindex.esp'";
        var raceCount = (long)raceCmd.ExecuteScalar()!;
        Assert.Equal(1, raceCount);
    }

    [Fact]
    public void Index_ArrayFormKeyField_IsIndexedInFormReferences()
    {
        FormKey kwFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-array-fk")
            .WithPlugin("ArrayFk.esp", mod =>
            {
                var kw = mod.Keywords.AddNew();
                kw.EditorID = "TestKw01";
                kwFormKey = kw.FormKey;

                var npc = mod.Npcs.AddNew("TestNPC_ArrayFk");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(kwFormKey)];
            })
            .Build();

        using var repo = OpenRepo();
        repo.Index(LoadMod(fixture.DataFolder, "ArrayFk.esp"), 0);
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        var kwRow = rows.FirstOrDefault(r => r.FieldPath == "keywords[0]");
        Assert.NotEqual(default, kwRow);
        Assert.Equal(kwFormKey.ToString(), kwRow.Target);
    }

    [Fact]
    public void Index_ArrayOfStructWithFormKeySubField_IsIndexedInFormReferences()
    {
        FormKey factionFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-array-struct")
            .WithPlugin("ArrayStruct.esp", mod =>
            {
                var faction = mod.Factions.AddNew("TestFaction01");
                factionFormKey = faction.FormKey;

                var npc = mod.Npcs.AddNew("TestNPC_ArrayStruct");
                npcFormKey = npc.FormKey;
                npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(factionFormKey) });
            })
            .Build();

        using var repo = OpenRepo();
        repo.Index(LoadMod(fixture.DataFolder, "ArrayStruct.esp"), 0);
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        var factionRow = rows.FirstOrDefault(r => r.FieldPath == "factions[0].faction");
        Assert.NotEqual(default, factionRow);
        Assert.Equal(factionFormKey.ToString(), factionRow.Target);
    }

    [Fact]
    public void Index_VmadStructWithObjectMember_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default;
        FormKey npcFormKey = default;

        using var fixture = new PluginFixtureBuilder("form-refs-vmad-struct")
            .WithPlugin("VmadStructRef.esp", mod =>
            {
                var target = mod.Npcs.AddNew("RefTarget");
                targetFormKey = target.FormKey;

                var npc = mod.Npcs.AddNew("VmadStructNpc");
                npcFormKey = npc.FormKey;

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();
                var objMember = new ScriptObjectProperty { Name = "TargetRef", Alias = -1 };
                objMember.Object.SetTo(targetFormKey);
                wrapper.Properties.Add(objMember);
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();

        using var repo = OpenRepo();
        repo.Index(LoadMod(fixture.DataFolder, "VmadStructRef.esp"), 0);
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT target_form_key, field_path FROM form_references WHERE source_form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string Target, string FieldPath)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1)));

        var row = rows.FirstOrDefault(r => r.FieldPath == @"VMAD\DefaultScript\Config\TargetRef");
        Assert.NotEqual(default, row);
        Assert.Equal(targetFormKey.ToString(), row.Target);
    }
}
