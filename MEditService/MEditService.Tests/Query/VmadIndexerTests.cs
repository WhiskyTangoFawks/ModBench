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

// Value/shape reconstruction (bool/object/array/struct properties) is covered behaviorally
// through repo.GetVmad(...) in GetVmadTests. These tests cover what is unique here:
// flag-string mapping, reindex idempotency, and form-reference registration for a
// top-level Object property.
public sealed class VmadIndexerTests : IDisposable
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

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
        var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
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
    public void GetVmad_MapsPropertyFlags_EditedAndZero()
    {
        using var repo = LoadedRepository();
        var props = repo.GetVmad(_npc1FormKey.ToString(), "VmadTest.esp")!
            .Scripts.First(s => s.Name == "DefaultScript").Properties;

        Assert.Equal("Edited", props.First(p => p.Name == "IsActive").Value.Flags);
        Assert.Equal("", props.First(p => p.Name == "ZeroFlagsTest").Value.Flags);
    }

    [Fact]
    public void GetVmad_MapsScriptFlags_InheritedAndRemoved()
    {
        using var repo = LoadedRepository();
        var scripts = repo.GetVmad(_npc1FormKey.ToString(), "VmadTest.esp")!.Scripts;

        Assert.Equal("Inherited and Removed",
            scripts.First(s => s.Name == "InheritedScript").Flags);
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
