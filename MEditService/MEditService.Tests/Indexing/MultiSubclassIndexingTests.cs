using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Indexing;

// Issue #263: a GRUP signature backed by several concrete Mutagen subclasses (the type
// discriminant lives on the record — an EditorID prefix for GameSetting/Global, a subrecord for
// others — never on the table) used to get its schema from whichever subclass schema discovery
// happened to enumerate first, so every record of any other subclass indexed with no value.
//
// These round-trip the real Index -> query pipeline (SchemaReflectorTests' Extract-only test
// covers the same defect at the schema seam without a database); this one also exercises DDL
// (TableDdlBuilder building the widened column) and the appender (AppendTyped's VARCHAR branch).
public class MultiSubclassIndexingTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static List<Dictionary<string, object?>> Query(DuckDbRecordRepository repo, string sql)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        using var reader = cmd.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>();
            for (int i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    [Fact]
    public void Index_Gmst_AllSubclasses_DataColumnRoundTripsForEveryType()
    {
        // All four asserted in one test deliberately (AC): the defect is invisible if only the
        // discovery-winning subclass (today GameSettingBool for FO4, by CLR reflection order — not
        // something to rely on) is checked.
        var mod = new Fallout4Mod(ModKey.FromFileName("Gmst263.esp"), Fallout4Release.Fallout4);
        mod.GameSettings.Add(new GameSettingInt(mod.GetNextFormKey("iTest"), Fallout4Release.Fallout4) { EditorID = "iTest", Data = 42 });
        mod.GameSettings.Add(new GameSettingFloat(mod.GetNextFormKey("fTest"), Fallout4Release.Fallout4) { EditorID = "fTest", Data = 3.5f });
        mod.GameSettings.Add(new GameSettingString(mod.GetNextFormKey("sTest"), Fallout4Release.Fallout4) { EditorID = "sTest", Data = "hello" });
        mod.GameSettings.Add(new GameSettingBool(mod.GetNextFormKey("bTest"), Fallout4Release.Fallout4) { EditorID = "bTest", Data = true });

        using var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, 0, participates: true, origin: "Data");
        repo.UpdateWinners();

        var rows = Query(repo, "SELECT editor_id, data FROM gmst ORDER BY editor_id");
        Assert.Equal(4, rows.Count);
        var byEdid = rows.ToDictionary(r => (string)r["editor_id"]!, r => r["data"]?.ToString());
        Assert.Equal("42", byEdid["iTest"]);
        Assert.Equal("3.5", byEdid["fTest"]);
        Assert.Equal("hello", byEdid["sTest"]);
        Assert.Equal("true", byEdid["bTest"]);
    }

    [Fact]
    public void Index_Glob_AllSubclasses_DataColumnRoundTripsForEveryType()
    {
        // Confirms the triage brief's "assume Global is affected too" rather than presuming it —
        // same shape as GMST (GlobalInt/Float/Short/Bool, all GLOB, each with its own Data type)
        // and fixed by the same table-agnostic mechanism, not a glob-specific code path.
        var mod = new Fallout4Mod(ModKey.FromFileName("Glob263.esp"), Fallout4Release.Fallout4);
        mod.Globals.Add(new GlobalInt(mod.GetNextFormKey("TestGlobInt"), Fallout4Release.Fallout4) { EditorID = "TestGlobInt", Data = 7 });
        mod.Globals.Add(new GlobalFloat(mod.GetNextFormKey("TestGlobFloat"), Fallout4Release.Fallout4) { EditorID = "TestGlobFloat", Data = 1.25f });
        mod.Globals.Add(new GlobalShort(mod.GetNextFormKey("TestGlobShort"), Fallout4Release.Fallout4) { EditorID = "TestGlobShort", Data = 3 });
        mod.Globals.Add(new GlobalBool(mod.GetNextFormKey("TestGlobBool"), Fallout4Release.Fallout4) { EditorID = "TestGlobBool", Data = true });

        using var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, 0, participates: true, origin: "Data");
        repo.UpdateWinners();

        var rows = Query(repo, "SELECT editor_id, data FROM \"glob\" ORDER BY editor_id");
        Assert.Equal(4, rows.Count);
        var byEdid = rows.ToDictionary(r => (string)r["editor_id"]!, r => r["data"]?.ToString());
        Assert.Equal("7", byEdid["TestGlobInt"]);
        Assert.Equal("1.25", byEdid["TestGlobFloat"]);
        Assert.Equal("3", byEdid["TestGlobShort"]);
        Assert.Equal("true", byEdid["TestGlobBool"]);
    }

    [Fact]
    public void Index_Dmgt_ConflictingListSiblings_DoesNotCrashAndKeepsWinnersColumnCorrect()
    {
        // DMGT turned out to be a second real example of the *non-scalar* carve-out (#339), not
        // the clean additive case it looks like at first glance: DamageType's own DamageTypes
        // (ExtendedList<DamageTypeItem>, a struct list, always non-null) and DamageTypeIndexed's
        // DamageTypes (ExtendedList<uint>?, a plain scalar list) share a column name but conflict
        // in element shape — exactly like OMOD's Properties, just with both sides happening to
        // share the "array" ApiType too. This round-trips both subclasses through the real
        // Index/query pipeline to prove the carve-out doesn't corrupt indexing (or throw) when a
        // non-winning sibling's instance meets the winner's typed PropertyInfo — it degrades to
        // null, the same as any other type mismatch this schema already tolerates, never a crash.
        // (SchemaReflectorTests' OMOD test pins the same rule at the schema/shape seam instead.)
        var mod = new Fallout4Mod(ModKey.FromFileName("Dmgt263.esp"), Fallout4Release.Fallout4);
        var plain = new DamageType(mod, "TestPlainDmgt");
        mod.DamageTypes.Add(plain);
        var indexed = new DamageTypeIndexed(mod, "TestIndexedDmgt") { DamageTypes = new ExtendedList<uint> { 5, 9 } };
        mod.DamageTypes.Add(indexed);

        // Which subclass wins the schema race is a reflection-order artifact this test must not
        // pin (see BuildForCategory's own comment) — ask the schema itself instead of assuming.
        var schemas = Reflector.GetSchemas(GameRelease.Fallout4);
        var winnerEdid = schemas["dmgt"].RecordType.IsInstanceOfType(plain) ? "TestPlainDmgt" : "TestIndexedDmgt";

        using var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, 0, participates: true, origin: "Data");
        repo.UpdateWinners();

        var rows = Query(repo, "SELECT editor_id, damage_types FROM dmgt ORDER BY editor_id");
        Assert.Equal(2, rows.Count); // rows are never dropped, whichever subclass loses the schema race
        var byEdid = rows.ToDictionary(r => (string)r["editor_id"]!, r => r["damage_types"]);
        Assert.NotNull(byEdid[winnerEdid]); // winner's own typed column still reads correctly
    }
}
