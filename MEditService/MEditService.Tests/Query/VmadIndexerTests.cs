using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

public sealed class VmadIndexerTests : IDisposable
{
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);

    private readonly FormKey _npc1FormKey;
    private readonly FormKey _npc2FormKey;
    private readonly PluginFixtureData _fixture;

    public VmadIndexerTests()
    {
        FormKey npc1Fk = default, npc2Fk = default;
        _fixture = new PluginFixtureBuilder()
            .WithPlugin("VmadTest.esp", mod =>
            {
                var npc2 = mod.Npcs.AddNew("ScriptedTarget");
                npc2Fk = npc2.FormKey;

                var npc1 = mod.Npcs.AddNew("ScriptedNpc");
                npc1Fk = npc1.FormKey;

                npc1.VirtualMachineAdapter = BuildVmad(npc2.FormKey);
            })
            .Build();
        _npc1FormKey = npc1Fk;
        _npc2FormKey = npc2Fk;
    }

    private static VirtualMachineAdapter BuildVmad(FormKey targetFk)
    {
        var vmad = new VirtualMachineAdapter();
        var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

        script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });

        var objProp = new ScriptObjectProperty { Name = "TargetActor", Alias = -1 };
        objProp.Object.SetTo(targetFk);
        script.Properties.Add(objProp);

        var intList = new ScriptIntListProperty { Name = "Scores" };
        intList.Data.Add(10);
        intList.Data.Add(20);
        intList.Data.Add(30);
        script.Properties.Add(intList);

        var boolList = new ScriptBoolListProperty { Name = "Flags" };
        boolList.Data.Add(true);
        boolList.Data.Add(false);
        script.Properties.Add(boolList);

        var structProp = new ScriptStructProperty { Name = "Config" };
        var member = new ScriptEntry { Name = "SubScript" };
        member.Properties.Add(new ScriptFloatProperty { Name = "Factor", Data = 1.5f });
        structProp.Members.Add(member);
        script.Properties.Add(structProp);

        script.Properties.Add(new ScriptStringProperty
        {
            Name = "ZeroFlagsTest",
            Data = "x",
            Flags = (ScriptProperty.Flag)0
        });

        vmad.Scripts.Add(script);

        var inheritedScript = new ScriptEntry
        {
            Name = "InheritedScript",
            Flags = ScriptEntry.Flag.InheritedAndRemoved
        };
        vmad.Scripts.Add(inheritedScript);

        return vmad;
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordRepository LoadedRepository()
    {
        var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName("VmadTest.esp"),
            Path.Combine(_fixture.DataFolder, "VmadTest.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();
        return repo;
    }

    private static T QueryScalar<T>(DuckDBConnection conn, string sql, params object[] args)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        for (int i = 0; i < args.Length; i++)
            cmd.Parameters.Add(new DuckDBParameter { Value = args[i] });
        return (T)Convert.ChangeType(cmd.ExecuteScalar()!, typeof(T), CultureInfo.InvariantCulture);
    }

    private static int CountRows(DuckDBConnection conn, string table, string? whereClause = null, params object[] args)
    {
        var sql = $"SELECT COUNT(*) FROM {table}" + (whereClause != null ? " WHERE " + whereClause : "");
        return (int)QueryScalar<long>(conn, sql, args);
    }

    [Fact]
    public void VmadScripts_HasCorrectNameAndFlags()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT script_name, flags, script_index FROM vmad_scripts WHERE form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read(), "Expected a vmad_scripts row");
        Assert.Equal("DefaultScript", reader.GetString(0));
        Assert.Equal("Local", reader.GetString(1));
        Assert.Equal(0, reader.GetInt32(2));
    }

    [Fact]
    public void VmadProperties_Bool_HasCorrectValue()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT type, bool_value, int_value, float_value, string_value, form_key_value, struct_json, flags
            FROM vmad_properties
            WHERE form_key = $1 AND property_name = 'IsActive'
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read());
        Assert.Equal("Bool", reader.GetString(0));
        Assert.True(reader.GetBoolean(1));
        Assert.True(reader.IsDBNull(2));
        Assert.True(reader.IsDBNull(3));
        Assert.True(reader.IsDBNull(4));
        Assert.True(reader.IsDBNull(5));
        Assert.True(reader.IsDBNull(6));
        Assert.Equal("Edited", reader.GetString(7));
    }

    [Fact]
    public void VmadProperties_Object_HasFormKeyAndAlias()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT type, form_key_value, alias_value, bool_value, int_value
            FROM vmad_properties
            WHERE form_key = $1 AND property_name = 'TargetActor'
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read());
        Assert.Equal("Object", reader.GetString(0));
        Assert.Equal(_npc2FormKey.ToString(), reader.GetString(1));
        Assert.Equal(-1, reader.GetInt16(2));
        Assert.True(reader.IsDBNull(3));
        Assert.True(reader.IsDBNull(4));
    }

    [Fact]
    public void VmadPropertyListItems_IntArray_HasThreeRowsInOrder()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT list_item_index, int_value
            FROM vmad_property_list_items
            WHERE form_key = $1 AND property_name = 'Scores'
            ORDER BY list_item_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(int idx, int val)>();
        while (reader.Read())
            rows.Add((reader.GetInt32(0), reader.GetInt32(1)));

        Assert.Equal(3, rows.Count);
        Assert.Equal((0, 10), rows[0]);
        Assert.Equal((1, 20), rows[1]);
        Assert.Equal((2, 30), rows[2]);
    }

    [Fact]
    public void VmadProperties_Struct_HasStructJsonNotNull_ScalarColumnsNull()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT type, struct_json, bool_value, int_value, float_value, string_value, form_key_value
            FROM vmad_properties
            WHERE form_key = $1 AND property_name = 'Config'
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read());
        Assert.Equal("Struct", reader.GetString(0));
        Assert.False(reader.IsDBNull(1));
        var json = reader.GetString(1);
        Assert.Contains("Factor", json);
        Assert.True(reader.IsDBNull(2));
        Assert.True(reader.IsDBNull(3));
        Assert.True(reader.IsDBNull(4));
        Assert.True(reader.IsDBNull(5));
        Assert.True(reader.IsDBNull(6));
    }

    [Fact]
    public void VmadPropertyListItems_BoolArray_HasCorrectValues()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT list_item_index, bool_value
            FROM vmad_property_list_items
            WHERE form_key = $1 AND property_name = 'Flags'
            ORDER BY list_item_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        var rows = new List<(int idx, bool val)>();
        while (reader.Read())
            rows.Add((reader.GetInt32(0), reader.GetBoolean(1)));

        Assert.Equal(2, rows.Count);
        Assert.Equal((0, true), rows[0]);
        Assert.Equal((1, false), rows[1]);
    }

    [Fact]
    public void VmadProperties_BoolArray_HasPropRow()
    {
        using var repo = LoadedRepository();
        var count = CountRows(repo.Connection, "vmad_properties",
            "form_key = $1 AND property_name = 'Flags' AND type = 'ArrayOfBool'",
            _npc1FormKey.ToString());
        Assert.Equal(1, count);
    }

    [Fact]
    public void VmadProperties_ZeroFlags_StoresEmptyString()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT flags FROM vmad_properties WHERE form_key = $1 AND property_name = 'ZeroFlagsTest'";
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        Assert.Equal("", (string?)cmd.ExecuteScalar());
    }

    [Fact]
    public void VmadScripts_InheritedAndRemovedFlag_StoresReadableString()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT flags FROM vmad_scripts WHERE form_key = $1 AND script_name = 'InheritedScript'";
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        Assert.Equal("Inherited and Removed", (string?)cmd.ExecuteScalar());
    }

    [Fact]
    public void Reindex_DoesNotDuplicateRows()
    {
        using var repo = LoadedRepository();
        var modPath = new ModPath(
            ModKey.FromFileName("VmadTest.esp"),
            Path.Combine(_fixture.DataFolder, "VmadTest.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);

        var count = CountRows(repo.Connection, "vmad_scripts",
            "form_key = $1 AND script_name = 'DefaultScript'",
            _npc1FormKey.ToString());
        Assert.Equal(1, count);
    }

    [Fact]
    public void VmadObjectProperty_RegistersFormReference()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT field_path, target_form_key
            FROM form_references
            WHERE source_form_key = $1 AND field_path LIKE 'VMAD%'
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _npc1FormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read(), "Expected a form_references row for VMAD Object property");
        Assert.Contains("VMAD", reader.GetString(0));
        Assert.Equal(_npc2FormKey.ToString(), reader.GetString(1));
    }
}
