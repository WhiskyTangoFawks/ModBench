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

// A GRUP signature backed by several concrete subclasses, discriminated per record rather than per
// table, must not take its schema from whichever subclass discovery enumerates first: that leaves
// every record of any other subclass indexed with no value.
public class MultiSubclassIndexingTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static List<Dictionary<string, object?>> Query(DuckDbRecordIndex repo, string sql)
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


    private static Dictionary<string, object?> FieldByEditorId(DuckDbRecordIndex repo, string table, string field)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var summary in repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: [table], Limit: 100, Offset: 0)).Items)
        {
            var detail = repo.At(RecordRef.Effective).GetDocument(summary.FormKey, new PluginKey(summary.Plugin, summary.Origin));
            Assert.NotNull(detail);
            var value = detail.Fields.FirstOrDefault(f => f.Metadata.Name == field);
            Assert.NotNull(value);
            result[summary.EditorId!] = value.Value;
        }
        return result;
    }

    [Fact]
    public void Index_Gmst_AllSubclasses_DataColumnRoundTripsForEveryType()
    {
        // All four asserted in one test deliberately: the defect is invisible if only the
        // discovery-winning subclass (today GameSettingBool for FO4, by CLR reflection order — not
        // something to rely on) is checked.
        var mod = new Fallout4Mod(ModKey.FromFileName("Gmst263.esp"), Fallout4Release.Fallout4);
        mod.GameSettings.Add(new GameSettingInt(mod.GetNextFormKey("iTest"), Fallout4Release.Fallout4) { EditorID = "iTest", Data = 42 });
        mod.GameSettings.Add(new GameSettingFloat(mod.GetNextFormKey("fTest"), Fallout4Release.Fallout4) { EditorID = "fTest", Data = 3.5f });
        mod.GameSettings.Add(new GameSettingString(mod.GetNextFormKey("sTest"), Fallout4Release.Fallout4) { EditorID = "sTest", Data = "hello" });
        mod.GameSettings.Add(new GameSettingBool(mod.GetNextFormKey("bTest"), Fallout4Release.Fallout4) { EditorID = "bTest", Data = true });

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var byEdid = FieldByEditorId(repo, "gmst", "Data").ToDictionary(kv => kv.Key, kv => kv.Value?.ToString());
        Assert.Equal(4, byEdid.Count);
        Assert.Equal("42", byEdid["iTest"]);
        Assert.Equal("3.5", byEdid["fTest"]);
        Assert.Equal("hello", byEdid["sTest"]);
        Assert.Equal("true", byEdid["bTest"]);
    }

    [Fact]
    public void Index_Glob_AllSubclasses_DataColumnRoundTripsForEveryType()
    {
        // Global is the same shape as GMST (GlobalInt/Float/Short/Bool, all GLOB, each with its
        // own Data type) and is covered by the same table-agnostic mechanism, not a glob-specific
        // code path — asserted rather than presumed.
        var mod = new Fallout4Mod(ModKey.FromFileName("Glob263.esp"), Fallout4Release.Fallout4);
        mod.Globals.Add(new GlobalInt(mod.GetNextFormKey("TestGlobInt"), Fallout4Release.Fallout4) { EditorID = "TestGlobInt", Data = 7 });
        mod.Globals.Add(new GlobalFloat(mod.GetNextFormKey("TestGlobFloat"), Fallout4Release.Fallout4) { EditorID = "TestGlobFloat", Data = 1.25f });
        mod.Globals.Add(new GlobalShort(mod.GetNextFormKey("TestGlobShort"), Fallout4Release.Fallout4) { EditorID = "TestGlobShort", Data = 3 });
        mod.Globals.Add(new GlobalBool(mod.GetNextFormKey("TestGlobBool"), Fallout4Release.Fallout4) { EditorID = "TestGlobBool", Data = true });

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var byEdid = FieldByEditorId(repo, "glob", "Data").ToDictionary(kv => kv.Key, kv => kv.Value?.ToString());
        Assert.Equal(4, byEdid.Count);
        Assert.Equal("7", byEdid["TestGlobInt"]);
        Assert.Equal("1.25", byEdid["TestGlobFloat"]);
        Assert.Equal("3", byEdid["TestGlobShort"]);
        Assert.Equal("true", byEdid["TestGlobBool"]);
    }

    [Fact]
    public void Index_Omod_AllSubclasses_PropertiesColumnRoundTripsForEveryType()
    {
        // The same defect for OMOD's five concrete subclasses, in one real Index-to-query round trip. It
        // is invisible if only the discovery-winning subclass is checked.
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

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var byEdid = FieldByEditorId(repo, "omod", "Properties").ToDictionary(kv => kv.Key, kv => kv.Value?.ToString());
        Assert.Equal(5, byEdid.Count);
        Assert.Contains("BodyPart", byEdid["ArmorMod"]);
        Assert.Contains("ForcedInventory", byEdid["NpcMod"]);
        Assert.Contains("AmmoCapacity", byEdid["WeaponMod"]);
        Assert.NotNull(byEdid["ObjectMod"]);
        Assert.NotNull(byEdid["UnknownMod"]);
    }

    [Fact]
    public void Index_Dmgt_ConflictingListSiblings_DoesNotCrashAndWinnersOwnShapeColumnStaysReadable()
    {
        // DMGT is a second non-scalar carve-out, not the additive case it looks like: the siblings'
        // DamageTypes share a column name but conflict in element shape.
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

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var byEdid = FieldByEditorId(repo, "dmgt", winnerColumnName);
        Assert.Equal(2, byEdid.Count); // rows are never dropped, whichever subclass loses the schema race
        Assert.NotNull(byEdid[winnerEdid]); // winner's own data is still readable, now via its shape column
    }

    [Fact]
    public void Index_Dmgt_BothSubclasses_EachRoundTripsThroughItsOwnShapeColumn()
    {
        // Distinct from the test above: a regression keeping both split columns but populating only the
        // discovery winner's would still pass that one, which never looks at the non-winner's column.
        var mod = new Fallout4Mod(ModKey.FromFileName("DmgtSplit339.esp"), Fallout4Release.Fallout4);
        var structShaped = new DamageType(mod, "PlainDmgt339");
        structShaped.DamageTypes.Add(new DamageTypeItem
        {
            ActorValue = new FormLink<IActorValueInformationGetter>(FormKey.Factory("000001:Test.esp")),
            Spell = new FormLink<ISpellGetter>(FormKey.Factory("000002:Test.esp")),
        });
        mod.DamageTypes.Add(structShaped);
        var scalarShaped = new DamageTypeIndexed(mod, "IndexedDmgt339") { DamageTypes = new ExtendedList<uint> { 7, 11 } };
        mod.DamageTypes.Add(scalarShaped);

        var schemas = Reflector.GetSchemas(GameRelease.Fallout4);
        var structColumnName = DmgtSplitColumns.StructShaped(schemas["dmgt"]).Name;
        var scalarColumnName = DmgtSplitColumns.ScalarShaped(schemas["dmgt"]).Name;

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var structValues = FieldByEditorId(repo, "dmgt", structColumnName);
        var scalarValues = FieldByEditorId(repo, "dmgt", scalarColumnName);
        Assert.Equal(2, structValues.Count);

        // Each sibling reads through its own shape column and nowhere else — the dispatch guard,
        // exercised against a record reconstituted from its document rather than against a wide row.
        Assert.NotNull(structValues["PlainDmgt339"]);
        Assert.Null(scalarValues["PlainDmgt339"]);

        Assert.NotNull(scalarValues["IndexedDmgt339"]);
        Assert.Null(structValues["IndexedDmgt339"]);
    }
}
