using System.Text.Json;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
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
    private static Dictionary<string, object?> FieldByEditorId(IRecordReads reads, string table, string field)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var summary in reads.Search(new RecordQuery(RecordTypes: [table], Limit: 100, Offset: 0)).Items)
        {
            var detail = reads.GetDocument(summary.FormKey, new PluginCopyKey(summary.Plugin, summary.Origin));
            Assert.NotNull(detail);
            var value = detail.Fields.FirstOrDefault(f => f.Metadata.Name == field);
            Assert.NotNull(value);
            var editorId = summary.EditorId
                ?? throw new InvalidOperationException($"Expected '{summary.FormKey}' to have an EditorID.");
            result[editorId] = value.Value;
        }
        return result;
    }

    private static Dictionary<string, JsonElement> JsonFieldByEditorId(IRecordReads reads, string table, string field) =>
        FieldByEditorId(reads, table, field).ToDictionary(
            kv => kv.Key,
            kv => (JsonElement)(kv.Value ?? throw new InvalidOperationException($"Expected a value for '{kv.Key}'.")));

    [Fact]
    public void Index_Gmst_AllSubclasses_DataColumnRoundTripsForEveryType()
    {
        // All four asserted in one test deliberately: the defect is invisible if only the
        // discovery-winning subclass (today GameSettingBool for FO4, by CLR reflection order — not
        // something to rely on) is checked.
        using var fixture = new PluginFixtureBuilder("gmst-subclasses")
            .WithPlugin("Gmst263.esp", mod =>
            {
                mod.GameSettings.Add(new GameSettingInt(mod.GetNextFormKey("iTest"), Fallout4Release.Fallout4) { EditorID = "iTest", Data = 42 });
                mod.GameSettings.Add(new GameSettingFloat(mod.GetNextFormKey("fTest"), Fallout4Release.Fallout4) { EditorID = "fTest", Data = 3.5f });
                mod.GameSettings.Add(new GameSettingString(mod.GetNextFormKey("sTest"), Fallout4Release.Fallout4) { EditorID = "sTest", Data = "hello" });
                mod.GameSettings.Add(new GameSettingBool(mod.GetNextFormKey("bTest"), Fallout4Release.Fallout4) { EditorID = "bTest", Data = true });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var byEdid = JsonFieldByEditorId(index.RequireReads(), "gmst", "Data");
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
        using var fixture = new PluginFixtureBuilder("glob-subclasses")
            .WithPlugin("Glob263.esp", mod =>
            {
                mod.Globals.Add(new GlobalInt(mod.GetNextFormKey("TestGlobInt"), Fallout4Release.Fallout4) { EditorID = "TestGlobInt", Data = 7 });
                mod.Globals.Add(new GlobalFloat(mod.GetNextFormKey("TestGlobFloat"), Fallout4Release.Fallout4) { EditorID = "TestGlobFloat", Data = 1.25f });
                mod.Globals.Add(new GlobalShort(mod.GetNextFormKey("TestGlobShort"), Fallout4Release.Fallout4) { EditorID = "TestGlobShort", Data = 3 });
                mod.Globals.Add(new GlobalBool(mod.GetNextFormKey("TestGlobBool"), Fallout4Release.Fallout4) { EditorID = "TestGlobBool", Data = true });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var byEdid = FieldByEditorId(index.RequireReads(), "glob", "Data");
        Assert.Equal(4, byEdid.Count);
        Assert.Equal(7, Assert.IsType<JsonElement>(byEdid["TestGlobInt"]).GetInt32());
        Assert.Equal(1.25f, Assert.IsType<JsonElement>(byEdid["TestGlobFloat"]).GetSingle());
        Assert.Equal(3, Assert.IsType<JsonElement>(byEdid["TestGlobShort"]).GetInt32());
        // Mutagen writes a GlobalBool's FLTV as one byte, so its value does not survive the binary;
        // the record still lands as its own subclass, with the null the overlay reads.
        Assert.True(byEdid.ContainsKey("TestGlobBool"));
    }

    [Fact]
    public void Index_Omod_AllSubclasses_PropertiesColumnRoundTripsForEveryType()
    {
        // The same defect for OMOD's five concrete subclasses, in one real reconcile-to-read round
        // trip. It is invisible if only the discovery-winning subclass is checked.
        using var fixture = new PluginFixtureBuilder("omod-subclasses")
            .WithPlugin("Omod339.esp", mod =>
            {
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
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var byEdid = FieldByEditorId(index.RequireReads(), "omod", "Properties").ToDictionary(kv => kv.Key, kv => kv.Value?.ToString());
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
        using var fixture = new PluginFixtureBuilder("dmgt-subclasses")
            .WithPlugin("DmgtSplit339.esp", mod =>
            {
                var structShaped = new DamageType(mod, "PlainDmgt339");
                structShaped.DamageTypes.Add(new DamageTypeItem
                {
                    ActorValue = new FormLink<IActorValueInformationGetter>(FormKey.Factory("000001:Test.esp")),
                    Spell = new FormLink<ISpellGetter>(FormKey.Factory("000002:Test.esp")),
                });
                mod.DamageTypes.Add(structShaped);
                // Below form version 78 the binary parser reads a DMGT as the indexed shape.
                var scalarShaped = new DamageTypeIndexed(mod, "IndexedDmgt339") { FormVersion = 77, DamageTypes = new ExtendedList<uint> { 7, 11 } };
                mod.DamageTypes.Add(scalarShaped);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        var values = JsonFieldByEditorId(reads, "dmgt", "DamageTypes");
        var classes = JsonFieldByEditorId(reads, "dmgt", "MutagenObjectType");
        Assert.Equal(2, values.Count);

        Assert.Equal(nameof(DamageType), classes["PlainDmgt339"].GetString());
        Assert.Equal("000001:Test.esp", values["PlainDmgt339"][0].GetProperty("ActorValue").GetString());
        Assert.Equal(nameof(DamageTypeIndexed), classes["IndexedDmgt339"].GetString());
        Assert.Equal([7, 11], values["IndexedDmgt339"].EnumerateArray().Select(e => e.GetInt32()));
    }
}
