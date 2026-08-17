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
    public void Index_Omod_AllSubclasses_PropertiesColumnRoundTripsForEveryType()
    {
        // #339: SchemaReflectorTests' schema/Extract-seam tests cover the same defect without a
        // database; this one also exercises DDL (TableDdlBuilder building the merged array column)
        // and the appender (AppendTyped's VARCHAR branch) for every one of OMOD's five concrete
        // subclasses in one real Index -> query round trip, same rationale as GMST/GLOB above:
        // the defect is invisible if only the discovery-winning subclass is checked.
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod339.esp"), Fallout4Release.Fallout4);

        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod"), Fallout4Release.Fallout4) { EditorID = "ArmorMod" };
        armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f });
        mod.ObjectModifications.Add(armor);

        var npc = new NpcModification(mod.GetNextFormKey("NpcMod"), Fallout4Release.Fallout4) { EditorID = "NpcMod" };
        npc.Properties.Add(new ObjectModIntProperty<Npc.Property> { Property = Npc.Property.ForcedInventory, Step = 2f });
        mod.ObjectModifications.Add(npc);

        var weapon = new WeaponModification(mod.GetNextFormKey("WeaponMod"), Fallout4Release.Fallout4) { EditorID = "WeaponMod" };
        weapon.Properties.Add(new ObjectModIntProperty<Weapon.Property> { Property = Weapon.Property.AmmoCapacity, Step = 3f });
        mod.ObjectModifications.Add(weapon);

        var obj = new ObjectModification(mod.GetNextFormKey("ObjectMod"), Fallout4Release.Fallout4) { EditorID = "ObjectMod" };
        obj.Properties.Add(new ObjectModIntProperty<AObjectModification.NoneProperty> { Step = 4f });
        mod.ObjectModifications.Add(obj);

        var unknown = new UnknownObjectModification(mod.GetNextFormKey("UnknownMod"), Fallout4Release.Fallout4) { EditorID = "UnknownMod" };
        unknown.Properties.Add(new ObjectModIntProperty<AObjectModification.NoneProperty> { Step = 5f });
        mod.ObjectModifications.Add(unknown);

        using var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, 0, participates: true, origin: "Data");
        repo.UpdateWinners();

        var rows = Query(repo, "SELECT editor_id, properties FROM omod ORDER BY editor_id");
        Assert.Equal(5, rows.Count);
        var byEdid = rows.ToDictionary(r => (string)r["editor_id"]!, r => (string?)r["properties"]);
        Assert.Contains("BodyPart", byEdid["ArmorMod"]);
        Assert.Contains("ForcedInventory", byEdid["NpcMod"]);
        Assert.Contains("AmmoCapacity", byEdid["WeaponMod"]);
        Assert.NotNull(byEdid["ObjectMod"]);
        Assert.NotNull(byEdid["UnknownMod"]);
    }

    [Fact]
    public void Index_Dmgt_ConflictingListSiblings_DoesNotCrashAndWinnersOwnShapeColumnStaysReadable()
    {
        // DMGT turned out to be a second real example of the *non-scalar* carve-out (#339), not
        // the clean additive case it looks like at first glance: DamageType's own DamageTypes
        // (ExtendedList<DamageTypeItem>, a struct list, always non-null) and DamageTypeIndexed's
        // DamageTypes (ExtendedList<uint>?, a plain scalar list) share a column name but conflict
        // in element shape. This round-trips both subclasses through the real Index/query pipeline
        // to prove indexing a plugin containing both siblings does not crash, and that the
        // discovery winner's own data is still readable.
        //
        // #339 rename/repoint: originally named …KeepsWinnersColumnCorrect and queried the fixed
        // name `damage_types`, which was safe before this ticket — whichever subclass won schema
        // discovery kept that name. It is not safe after: naming is now shape-based (`damage_types`
        // is always the struct shape, `actor_value_indices` always the scalar shape) precisely so a
        // Mutagen package bump reordering reflection metadata can never silently rename a
        // production DuckDB column that the frontend and user-written SQL filters depend on — see
        // SplitNonScalarByShape's own comment. That means there is no longer a single "winner's
        // column" name to hardcode. Same protection as before — crash-free indexing of both
        // siblings, and the winner's own value reads back non-null — relocated to look the column
        // up by shape (DmgtSplitColumns, the same mechanism SchemaReflectorTests' split test uses)
        // rather than assume a name.
        var mod = new Fallout4Mod(ModKey.FromFileName("Dmgt263.esp"), Fallout4Release.Fallout4);
        var plain = new DamageType(mod, "TestPlainDmgt");
        mod.DamageTypes.Add(plain);
        var indexed = new DamageTypeIndexed(mod, "TestIndexedDmgt") { DamageTypes = new ExtendedList<uint> { 5, 9 } };
        mod.DamageTypes.Add(indexed);

        // Which subclass wins the schema race is a reflection-order artifact this test must not
        // pin (see BuildForCategory's own comment) — ask the schema itself instead of assuming.
        var schemas = Reflector.GetSchemas(GameRelease.Fallout4);
        var winnerIsStructShaped = schemas["dmgt"].RecordType.IsInstanceOfType(plain);
        var winnerEdid = winnerIsStructShaped ? "TestPlainDmgt" : "TestIndexedDmgt";
        var winnerColumnName = (winnerIsStructShaped
            ? DmgtSplitColumns.StructShaped(schemas["dmgt"])
            : DmgtSplitColumns.ScalarShaped(schemas["dmgt"])).Name;

        using var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, 0, participates: true, origin: "Data");
        repo.UpdateWinners();

        var rows = Query(repo, $"SELECT editor_id, \"{winnerColumnName}\" AS winner_value FROM dmgt ORDER BY editor_id");
        Assert.Equal(2, rows.Count); // rows are never dropped, whichever subclass loses the schema race
        var byEdid = rows.ToDictionary(r => (string)r["editor_id"]!, r => r["winner_value"]);
        Assert.NotNull(byEdid[winnerEdid]); // winner's own data is still readable, now via its shape column
    }
}
