using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
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
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var byEdid = FieldByEditorId(repo, "gmst", "Data").ToDictionary(kv => kv.Key, kv => (JsonElement)kv.Value!);
        Assert.Equal(4, byEdid.Count);
        Assert.Equal(42, byEdid["iTest"].GetInt32());
        Assert.Equal(3.5f, byEdid["fTest"].GetSingle());
        // A game setting's string is a translated string, which the codec spells as an object.
        Assert.Equal("hello", byEdid["sTest"].GetProperty("Value").GetString());
        Assert.True(byEdid["bTest"].GetBoolean());
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
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var byEdid = FieldByEditorId(repo, "glob", "Data").ToDictionary(kv => kv.Key, kv => (JsonElement)kv.Value!);
        Assert.Equal(4, byEdid.Count);
        Assert.Equal(7, byEdid["TestGlobInt"].GetInt32());
        Assert.Equal(1.25f, byEdid["TestGlobFloat"].GetSingle());
        Assert.Equal(3, byEdid["TestGlobShort"].GetInt32());
        Assert.True(byEdid["TestGlobBool"].GetBoolean());
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
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
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
    public void Index_Dmgt_BothSubclasses_EachReadsItsOwnShapeThroughTheOneDamageTypesColumn()
    {
        // DamageType and DamageTypeIndexed declare DamageTypes with different element shapes: one
        // column, one variant per record class, each record's document read as its own class.
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

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var values = FieldByEditorId(repo, "dmgt", "DamageTypes").ToDictionary(kv => kv.Key, kv => (JsonElement)kv.Value!);
        var classes = FieldByEditorId(repo, "dmgt", "MutagenObjectType").ToDictionary(kv => kv.Key, kv => (JsonElement)kv.Value!);
        Assert.Equal(2, values.Count);

        Assert.Equal(nameof(DamageType), classes["PlainDmgt339"].GetString());
        Assert.Equal("000001:Test.esp", values["PlainDmgt339"][0].GetProperty("ActorValue").GetString());
        Assert.Equal(nameof(DamageTypeIndexed), classes["IndexedDmgt339"].GetString());
        Assert.Equal([7, 11], values["IndexedDmgt339"].EnumerateArray().Select(e => e.GetInt32()));
    }
}
