using System.Globalization;
using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

public class SchemaReflectorTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    [Fact]
    public void GetSchemas_ContainsKnownFallout4RecordTypes()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("npc_"));
        Assert.True(schemas.ContainsKey("weap"));
        Assert.True(schemas.ContainsKey("armo"));
    }

    [Fact]
    public void GetSchemas_IncludesPlacedRecordTypes()
    {
        // ADR-0023: placed objects are indexed as normal records so the worldspace tree,
        // record editor, and agent queries are uniform DuckDB reads.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("refr"));
        Assert.True(schemas.ContainsKey("achr"));
    }

    [Fact]
    public void GetSchemas_StillExcludesNonReferenceCellChildren()
    {
        // Landscape and navmesh live in cell children too but aren't standard refs.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.False(schemas.ContainsKey("land"));
        Assert.False(schemas.ContainsKey("navm"));
        Assert.False(schemas.ContainsKey("navi"));
    }

    // ── the virtual-machine adapter is an ordinary reflected column ───────────

    [Fact]
    public void GetSchemas_Npc_VirtualMachineAdapter_IsAReflectedStructColumn()
    {
        var columns = _reflector.GetSchemas(GameRelease.Fallout4)["npc_"].RecordColumns;

        var adapter = Assert.Single(columns, c => c.Name == "virtual_machine_adapter");
        Assert.Equal("struct", adapter.ApiType);
        Assert.NotNull(adapter.Apply.Writer);
    }

    [Fact]
    public void GetSchemas_Cmpo_CarriesNoAdapter_BecauseTheRecordTypeHasNone()
    {
        // CMPO ("Component") has no VMAD subrecord per xEdit's format definition
        // (wbDefinitionsFO4.pas), and Component_Generated.cs declares no VirtualMachineAdapter
        // property — so the column's absence is the record type's own shape, not an exclusion.
        var columns = _reflector.GetSchemas(GameRelease.Fallout4)["cmpo"].RecordColumns;

        Assert.DoesNotContain(columns, c => c.Name == "virtual_machine_adapter");
        Assert.Contains(columns, c => c.Name == "auto_calc_value");
    }

    // ── xEdit-parity display names ────────────────────────────────────────────

    [Fact]
    public void GetSchemas_Acti_DisplayName_MatchesXEdit()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.Equal("Activator", schemas["acti"].DisplayName);
    }

    [Fact]
    public void GetSchemas_Gmst_DisplayName_MatchesXEdit()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.Equal("Game Setting", schemas["gmst"].DisplayName);
    }

    // ── GMST/GLOB's Data column is backed by several concrete subclasses, discriminated per record
    // rather than per table, so schema discovery must not pick one subclass's Data property and drop
    // the rest. ────────────────────────────────

    [Fact]
    public void GetSchemas_Gmst_DataColumn_ExtractsCorrectValuePerSubclass()
    {
        // All four asserted in one test deliberately: the bug is invisible if only the
        // discovery-winning subclass is checked (today that's GameSettingBool for FO4 — an
        // artifact of CLR reflection order, not something this test may rely on).
        var mod = new Fallout4Mod(ModKey.FromFileName("Gmst263.esp"), Fallout4Release.Fallout4);
        var i = new GameSettingInt(mod.GetNextFormKey("iTest"), Fallout4Release.Fallout4) { EditorID = "iTest", Data = 42 };
        var f = new GameSettingFloat(mod.GetNextFormKey("fTest"), Fallout4Release.Fallout4) { EditorID = "fTest", Data = 3.5f };
        var s = new GameSettingString(mod.GetNextFormKey("sTest"), Fallout4Release.Fallout4) { EditorID = "sTest", Data = "hello" };
        var b = new GameSettingBool(mod.GetNextFormKey("bTest"), Fallout4Release.Fallout4) { EditorID = "bTest", Data = true };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var data = schemas["gmst"].RecordColumns.Single(c => c.Name == "data");

        // Widened scalars format as text (FormatWidenedValue) — int/float via InvariantCulture,
        // not the raw boxed value, so the column round-trips through CoerceToColumnType's VARCHAR
        // branch (a bare ToString(), see CoerceToColumnType) the same way on every host.
        Assert.Equal("42", data.Extract(i));
        Assert.Equal("3.5", data.Extract(f));
        Assert.Equal("hello", data.Extract(s));
        Assert.Equal("true", data.Extract(b));
    }

    [Fact]
    public void GetSchemas_Gmst_DataColumn_WidenedFloatFormattingIsCultureInvariant()
    {
        // FormatWidenedValue handing a raw boxed float to CoerceToColumnType's VARCHAR branch, whose
        // value.ToString() carries no culture, round-trips 3.5 as "3,5" under a comma-decimal
        // culture.
        var original = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");

            var mod = new Fallout4Mod(ModKey.FromFileName("GmstCulture263.esp"), Fallout4Release.Fallout4);
            var f = new GameSettingFloat(mod.GetNextFormKey("fTest"), Fallout4Release.Fallout4) { EditorID = "fTest", Data = 3.5f };

            var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
            var data = schemas["gmst"].RecordColumns.Single(c => c.Name == "data");

            Assert.Equal("3.5", data.Extract(f));
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Fact]
    public void GetSchemas_Gmst_DataColumn_WidenedBoolFalse_FormatsAsLowercaseFalse()
    {
        // Mutation-triage gap: the per-subclass test above only asserts Data = true, so FormatWidenedValue's
        // bool branch is never exercised with a false input and a mutant collapsing it survives.
        var mod = new Fallout4Mod(ModKey.FromFileName("Gmst365BoolFalse.esp"), Fallout4Release.Fallout4);
        var b = new GameSettingBool(mod.GetNextFormKey("bFalseTest"), Fallout4Release.Fallout4) { EditorID = "bFalseTest", Data = false };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var data = schemas["gmst"].RecordColumns.Single(c => c.Name == "data");

        Assert.Equal("false", data.Extract(b));
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_KeepsStructuredArrayShape_NotWidened()
    {
        // OMOD's Properties is the same per-subclass-typed shape as GMST/GLOB's Data, but on a list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");

        Assert.Equal("array", properties.ApiType);
        Assert.NotNull(properties.ElementType);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_ExtractsCorrectPropertyAndStepForEverySubclass()
    {
        // An Extract bound to whichever sibling won schema discovery makes every other sibling's
        // Properties list read back null: a foreign PropertyInfo throws and the throw is swallowed. All
        // five subclasses share the same generic element classes, only T varying.
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod339.esp"), Fallout4Release.Fallout4);

        // Not added to mod.ObjectModifications (the one shared Fallout4Group<AObjectModification>
        // every sibling actually lives in, confirmed against Fallout4Mod_Generated.cs — there is no
        // per-subclass group) — Extract only needs a standalone instance of each concrete type.
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod"), Fallout4Release.Fallout4) { EditorID = "ArmorMod" };
        armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f });

        var npc = new NpcModification(mod.GetNextFormKey("NpcMod"), Fallout4Release.Fallout4) { EditorID = "NpcMod" };
        npc.Properties.Add(new ObjectModIntProperty<Npc.Property> { Property = Npc.Property.ForcedInventory, Step = 2f });

        var weapon = new WeaponModification(mod.GetNextFormKey("WeaponMod"), Fallout4Release.Fallout4) { EditorID = "WeaponMod" };
        weapon.Properties.Add(new ObjectModIntProperty<Weapon.Property> { Property = Weapon.Property.AmmoCapacity, Step = 3f });

        var obj = new ObjectModification(mod.GetNextFormKey("ObjectMod"), Fallout4Release.Fallout4) { EditorID = "ObjectMod" };
        obj.Properties.Add(new ObjectModIntProperty<AObjectModification.NoneProperty> { Step = 4f });

        var unknown = new UnknownObjectModification(mod.GetNextFormKey("UnknownMod"), Fallout4Release.Fallout4) { EditorID = "UnknownMod" };
        unknown.Properties.Add(new ObjectModIntProperty<AObjectModification.NoneProperty> { Step = 5f });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");

        // Merging makes this column dispatch-guarded: a record of a sixth, non-OMOD subclass would
        // read null through it, so AllowsNull must say so rather than still claim false.
        Assert.True(properties.AllowsNull);

        AssertFirstElement(properties, armor, "BodyPart", 1f);
        AssertFirstElement(properties, npc, "ForcedInventory", 2f);
        AssertFirstElement(properties, weapon, "AmmoCapacity", 3f);
        // AObjectModification.NoneProperty (Object/Unknown's T) is a genuinely empty enum — 0
        // members — confirmed against the real source (ObjectModification.cs), not assumed.
        AssertFirstElement(properties, obj, "0", 4f);
        AssertFirstElement(properties, unknown, "0", 5f);

        static void AssertFirstElement(ColumnSpec properties, IMajorRecordGetter record, string expectedProperty, float expectedStep)
        {
            var json = properties.Extract(record) as string;
            Assert.NotNull(json);
            var items = JsonSerializer.Deserialize<List<Dictionary<string, JsonElement>>>(json);
            Assert.NotNull(items);
            var element = Assert.Single(items);
            Assert.Equal(expectedProperty, element["property"].GetString());
            Assert.Equal(expectedStep, element["step"].GetSingle());
        }
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_PropertySubField_EnumMembersAreUnionOfSiblingEnums()
    {
        // The `property` sub-field's members are the union of every sibling's own T enum member
        // names.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var propertyField = properties.ElementType!.Fields!.Single(f => f.Name == "property");

        var values = propertyField.EnumMembers.Select(m => m.Value).ToList();
        Assert.Contains("BodyPart", values); // Armor.Property-only member
        Assert.Contains("ForcedInventory", values); // Npc.Property-only member
        Assert.Contains("AmmoCapacity", values); // Weapon.Property-only member
        Assert.Contains("Keywords", values); // shared by Armor.Property and Npc.Property — union must not duplicate it
        Assert.Equal(values.Count, values.Distinct().Count());
    }

    // ── OMOD's Properties element must surface the property's actual Value ──
    //
    // IAObjectModPropertyGetter<T> declares only Property/Step; the payload lives on seven leaf getter
    // interfaces BuildSubSchema descends into. Read-only: the write path is a separate known defect.

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_ExposesSevenLeafUnionFields()
    {
        // Schema-shape half of the fix; the seven extraction tests below are the value half —
        // this alone doesn't prove any leaf's own data actually reaches these fields.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var fields = properties.ElementType!.Fields!;

        var value = fields.Single(f => f.Name == "value");
        var value2 = fields.Single(f => f.Name == "value2");
        var record = fields.Single(f => f.Name == "record");
        var functionType = fields.Single(f => f.Name == "function_type");
        var enumIntValue = fields.Single(f => f.Name == "enum_int_value");

        // value/value2/function_type collide in CLR type across the seven leaves, so they take the
        // read-only-text rung. record and enum_int_value do not collide across the leaves that declare
        // them, so they stay typed.
        Assert.Equal("string", value.Type);
        Assert.Equal("string", value2.Type);
        Assert.Equal("string", functionType.Type);
        Assert.Equal("formKey", record.Type);
        Assert.Equal("int", enumIntValue.Type);

        // Every one of these is sparse — declared by some leaves, not all — so every row of a
        // non-declaring leaf's type legitimately reads null through it.
        Assert.True(value.AllowsNull);
        Assert.True(value2.AllowsNull);
        Assert.True(record.AllowsNull);
        Assert.True(functionType.AllowsNull);
        Assert.True(enumIntValue.AllowsNull);

        // Unused is deliberately excluded: Mutagen's own name for it, and xEdit's
        // wbUnused(3)/wbUnused(2), never rendered as a field at all, both agree it carries no
        // product-visible data.
        Assert.DoesNotContain(fields, f => f.Name == "unused");
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_IntLeaf_ExposesValueValue2FunctionType()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod360Int.esp"), Fallout4Release.Fallout4);
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod360Int"), Fallout4Release.Fallout4) { EditorID = "ArmorMod360Int" };
        armor.Properties.Add(new ObjectModIntProperty<Armor.Property>
        {
            Property = Armor.Property.BodyPart,
            Step = 1f,
            Value = 10,
            Value2 = 20,
            FunctionType = ObjectModProperty.FloatFunctionType.Add,
        });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var element = ExtractFirstElement(properties, armor);

        Assert.Equal("10", element["value"].GetString());
        Assert.Equal("20", element["value2"].GetString());
        Assert.Equal("Add", element["function_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["record"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["enum_int_value"].ValueKind);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_FloatLeaf_ExposesValueValue2FunctionType()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod360Float.esp"), Fallout4Release.Fallout4);
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod360Float"), Fallout4Release.Fallout4) { EditorID = "ArmorMod360Float" };
        armor.Properties.Add(new ObjectModFloatProperty<Armor.Property>
        {
            Property = Armor.Property.BodyPart,
            Step = 1f,
            Value = 1.5f,
            Value2 = 2.5f,
            FunctionType = ObjectModProperty.FloatFunctionType.MultAndAdd,
        });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var element = ExtractFirstElement(properties, armor);

        Assert.Equal("1.5", element["value"].GetString());
        Assert.Equal("2.5", element["value2"].GetString());
        Assert.Equal("MultAndAdd", element["function_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["record"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["enum_int_value"].ValueKind);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_BoolLeaf_ExposesValueValue2FunctionType()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod360Bool.esp"), Fallout4Release.Fallout4);
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod360Bool"), Fallout4Release.Fallout4) { EditorID = "ArmorMod360Bool" };
        armor.Properties.Add(new ObjectModBoolProperty<Armor.Property>
        {
            Property = Armor.Property.BodyPart,
            Step = 1f,
            Value = true,
            Value2 = false,
            FunctionType = ObjectModProperty.BoolFunctionType.Or,
        });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var element = ExtractFirstElement(properties, armor);

        Assert.Equal("true", element["value"].GetString());
        Assert.Equal("false", element["value2"].GetString());
        Assert.Equal("Or", element["function_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["record"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["enum_int_value"].ValueKind);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_StringLeaf_ExposesValueFunctionType_NoValue2()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod360String.esp"), Fallout4Release.Fallout4);
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod360String"), Fallout4Release.Fallout4) { EditorID = "ArmorMod360String" };
        armor.Properties.Add(new ObjectModStringProperty<Armor.Property>
        {
            Property = Armor.Property.BodyPart,
            Step = 1f,
            Value = "Hello360",
            FunctionType = ObjectModProperty.FloatFunctionType.Set,
        });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var element = ExtractFirstElement(properties, armor);

        Assert.Equal("Hello360", element["value"].GetString());
        Assert.Equal(JsonValueKind.Null, element["value2"].ValueKind);
        Assert.Equal("Set", element["function_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["record"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["enum_int_value"].ValueKind);
        // Reserved padding, not a product-visible field on any leaf — never a key at all.
        Assert.False(element.ContainsKey("unused"));
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_EnumLeaf_ExposesEnumIntValueFunctionType()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod360Enum.esp"), Fallout4Release.Fallout4);
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod360Enum"), Fallout4Release.Fallout4) { EditorID = "ArmorMod360Enum" };
        armor.Properties.Add(new ObjectModEnumProperty<Armor.Property>
        {
            Property = Armor.Property.BodyPart,
            Step = 1f,
            EnumIntValue = 7,
            FunctionType = ObjectModProperty.EnumFunctionType.Set,
        });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var element = ExtractFirstElement(properties, armor);

        Assert.Equal(7, element["enum_int_value"].GetInt32());
        Assert.Equal("Set", element["function_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["value"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["value2"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["record"].ValueKind);
        Assert.False(element.ContainsKey("unused"));
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_FormLinkIntLeaf_ExposesRecordValueFunctionType()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod360FormLinkInt.esp"), Fallout4Release.Fallout4);
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod360FLInt"), Fallout4Release.Fallout4) { EditorID = "ArmorMod360FLInt" };
        var target = FormKey.Factory("000ABC:Test.esp");
        armor.Properties.Add(new ObjectModFormLinkIntProperty<Armor.Property>
        {
            Property = Armor.Property.BodyPart,
            Step = 1f,
            Record = new FormLink<IFallout4MajorRecordGetter>(target),
            Value = 42,
            FunctionType = ObjectModProperty.FormLinkFunctionType.Add,
        });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var element = ExtractFirstElement(properties, armor);

        Assert.Equal(target.ToString(), element["record"].GetString());
        Assert.Equal("42", element["value"].GetString());
        Assert.Equal("Add", element["function_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["value2"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["enum_int_value"].ValueKind);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_FormLinkFloatLeaf_ExposesRecordValueFunctionType()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Omod360FormLinkFloat.esp"), Fallout4Release.Fallout4);
        var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod360FLFloat"), Fallout4Release.Fallout4) { EditorID = "ArmorMod360FLFloat" };
        var target = FormKey.Factory("000DEF:Test.esp");
        armor.Properties.Add(new ObjectModFormLinkFloatProperty<Armor.Property>
        {
            Property = Armor.Property.BodyPart,
            Step = 1f,
            Record = new FormLink<IFallout4MajorRecordGetter>(target),
            Value = 3.5f,
            FunctionType = ObjectModProperty.FloatFunctionType.Set,
        });

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var element = ExtractFirstElement(properties, armor);

        Assert.Equal(target.ToString(), element["record"].GetString());
        Assert.Equal("3.5", element["value"].GetString());
        Assert.Equal("Set", element["function_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["value2"].ValueKind);
        Assert.Equal(JsonValueKind.Null, element["enum_int_value"].ValueKind);
    }

    private static Dictionary<string, JsonElement> ExtractFirstElement(ColumnSpec properties, IMajorRecordGetter record)
    {
        var json = properties.Extract(record) as string;
        Assert.NotNull(json);
        var items = JsonSerializer.Deserialize<List<Dictionary<string, JsonElement>>>(json);
        Assert.NotNull(items);
        return Assert.Single(items);
    }

    [Fact]
    public void GetSchemas_Dmgt_SplitsIntoPerShapeColumns_EachDispatchGuardedToOwnSubclass()
    {
        // DamageType.DamageTypes and DamageTypeIndexed.DamageTypes are a genuine, irreconcilable shape
        // conflict with no field names in common. 'actor_value_indices' borrows xEdit's own element
        // vocabulary (ADR-0034); naming is shape-based because the discovery race must not be pinned.
        var mod = new Fallout4Mod(ModKey.FromFileName("DmgtSplit339.esp"), Fallout4Release.Fallout4);
        var structShaped = new DamageType(mod, "PlainDmgt339");
        structShaped.DamageTypes.Add(new DamageTypeItem
        {
            ActorValue = new FormLink<IActorValueInformationGetter>(FormKey.Factory("000001:Test.esp")),
            Spell = new FormLink<ISpellGetter>(FormKey.Factory("000002:Test.esp")),
        });
        var scalarShaped = new DamageTypeIndexed(mod, "IndexedDmgt339") { DamageTypes = new Noggog.ExtendedList<uint> { 7, 11 } };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var damageTypes = DmgtSplitColumns.StructShaped(schemas["dmgt"]);
        var actorValueIndices = DmgtSplitColumns.ScalarShaped(schemas["dmgt"]);

        // The shape-based lookup above is deliberately name-agnostic (it is what the round-trip
        // test below shares); the fixed names are still this test's own point, asserted directly.
        Assert.Equal("damage_types", damageTypes.Name);
        Assert.Equal("actor_value_indices", actorValueIndices.Name);
        Assert.Equal("int", actorValueIndices.ElementType!.Type);

        // Both sides of a split are dispatch-guarded, not just the newly-appended one — a
        // DamageType row legitimately reads null through actor_value_indices and vice versa, so
        // both columns must say AllowsNull, not just whichever one wasn't the discovery winner.
        Assert.True(damageTypes.AllowsNull);
        Assert.True(actorValueIndices.AllowsNull);

        // Each column reads only its own subclass — by construction (a type check before the
        // reflected getter is ever invoked), not by falling through to a swallowed reflection
        // throw. Foreign-instance reads return null either way; the point is *how*.
        Assert.NotNull(damageTypes.Extract(structShaped));
        Assert.Null(damageTypes.Extract(scalarShaped));
        Assert.NotNull(actorValueIndices.Extract(scalarShaped));
        Assert.Null(actorValueIndices.Extract(structShaped));
    }

    [Fact]
    public void GetSchemas_Glob_OutputCharColumn_ExclusiveToGlobalFloat_NullOnOtherSubclasses()
    {
        // The "not present on every sibling" branch of MergeSiblingColumn is real today, not a
        // hypothetical kept for a future third subclass. Extracting off a real GlobalBool instance, rather
        // than arguing from AllowsNull, is what discharges the nullability requirement.
        var mod = new Fallout4Mod(ModKey.FromFileName("GlobOutputChar263.esp"), Fallout4Release.Fallout4);
        var f = new GlobalFloat(mod.GetNextFormKey("TestGlobFloat"), Fallout4Release.Fallout4) { EditorID = "TestGlobFloat", Data = 1.25f, OutputChar = true };
        var b = new GlobalBool(mod.GetNextFormKey("TestGlobBool"), Fallout4Release.Fallout4) { EditorID = "TestGlobBool", Data = true };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var outputChar = schemas["glob"].RecordColumns.Single(c => c.Name == "output_char");

        Assert.True(outputChar.AllowsNull);
        Assert.Equal(true, outputChar.Extract(f));
        Assert.Null(outputChar.Extract(b));
    }

    [Fact]
    public void GetSchemas_EveryDiscoveredTable_HasANonEmptyDisplayName()
    {
        // Guards the hand-transcribed RecordDisplayNames table: every table Mutagen reflection
        // currently surfaces must have a real xEdit-sourced name, not a silent fallback to the
        // raw signature (which RecordDisplayNames.For only does for a lookup miss).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var missing = schemas
            .Where(kv => string.IsNullOrEmpty(kv.Value.DisplayName) || kv.Value.DisplayName == kv.Key)
            .Select(kv => kv.Key)
            .ToList();
        Assert.Empty(missing);
    }

    [Fact]
    public void GetSchemas_Npc_BoolColumn_MapsToBooleanDuckDbType()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggro_radius_behavior_enabled");
        Assert.NotNull(col);
        Assert.Equal("BOOLEAN", col.DuckDbType);
        Assert.Equal("bool", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_MapsToVarcharWithEnumMembers()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("enum", col.ApiType);
        Assert.NotEmpty(col.EnumMembers);
        Assert.Contains("Unaggressive", col.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_Apply_SetsEnumValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "aggression");
        Assert.NotNull(col.Apply.Writer);
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("\"Unaggressive\"").RootElement);
        Assert.Equal("Unaggressive", col.Extract(npc)?.ToString());

        // confirm ignoreCase: true
        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("\"aggressive\"").RootElement);
        Assert.Equal("Aggressive", col.Extract(npc)?.ToString());
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_MapsToFormKeyTypeWithValidTypes()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "race");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("formKey", col.ApiType);
        Assert.Contains("race", col.ValidFormKeyTypes);
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_Apply_MalformedFormKeyString_IsRejected()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "race");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var originalRace = npc.Race.FormKeyNullable;

        var outcome = col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("\"not-a-formkey\"").RootElement);

        Assert.Equal(ApplyOutcome.ValueRejected, outcome);
        Assert.Equal(originalRace, npc.Race.FormKeyNullable);
    }

    [Fact]
    public void GetSchemas_Npc_Race_IsNonNullableFormLink()
    {
        // Race is IFormLink<IRaceGetter> — non-nullable; AllowsNull must be false.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "race");
        Assert.NotNull(col);
        Assert.False(col!.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Voice_IsNullableFormLink()
    {
        // Voice is IFormLinkNullable<IVoiceTypeGetter> — AllowsNull must be true.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "voice");
        Assert.NotNull(col);
        Assert.True(col!.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Faction_SubField_IsNonNullableFormLink()
    {
        // RankPlacement.Faction is IFormLink<IFactionGetter> — non-nullable sub-field.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);
        var faction = col!.ElementType?.Fields?.FirstOrDefault(f => f.Name == "faction");
        Assert.NotNull(faction);
        Assert.False(faction!.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_HasApply()
    {
        // A top-level FormLink column carries the same ApplyFormLinkJson write delegate as its
        // struct/array sub-field sibling — not a null-Apply read-only column.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "race");
        Assert.NotNull(col);
        // The delegate, not the LeafWrite wrapper: asserting the wrapper is unconditionally true now that
        // Apply is non-nullable, which would leave this fact proving nothing at all.
        Assert.NotNull(col!.Apply.Writer);
    }

    [Fact]
    public void GetSchemas_Npc_StringColumn_MapsToVarcharStringType()
    {
        // EditorID is excluded from RecordColumns (it's a base column), but Name is a translated string.
        // BleedoutOverride is a short/int type. Find a string or translated-string column on NPC.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        // The NPC Name is a TranslatedString — maps to VARCHAR/"string"
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "name");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("string", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_Name_Extract_ReturnsStringValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "name");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Test.esp"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            Name = new Mutagen.Bethesda.Strings.TranslatedString(
                Mutagen.Bethesda.Strings.Language.English, "Testname")
        };
        Assert.Equal("Testname", col.Extract(npc));
    }

    [Fact]
    public void GetSchemas_Npc_Name_Extract_WhenNull_ReturnsNull()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "name");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Test.esp"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            Name = null
        };
        Assert.Null(col.Extract(npc));
    }

    [Fact]
    public void GetSchemas_IsCachedAcrossCalls()
    {
        var first = _reflector.GetSchemas(GameRelease.Fallout4);
        var second = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.Same(first, second);
    }

    // ── Array and struct field types ─────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_IsReflectedAsArrayOfFormKeys()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.ElementType);
        Assert.Equal("formKey", col.ElementType.Type);
        Assert.Contains("kywd", col.ElementType.ValidFormKeyTypes);
    }

    [Fact]
    public void GetSchemas_Npc_Keywords_IsSortable()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.NotNull(col.ElementType);
        Assert.True(col.ElementType.IsSortable);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_IsReflectedAsArrayOfStructs()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.ElementType);
        Assert.Equal("struct", col.ElementType.Type);
        var fields = col.ElementType.Fields;
        Assert.NotNull(fields);
        Assert.Contains(fields, f => f.Name == "faction" && f.Type == "formKey");
        Assert.Contains(fields, f => f.Name == "rank" && f.Type == "int");
    }

    [Fact]
    public void GetSchemas_Npc_Keywords_Extract_ReturnsJsonArray()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);

        // Build a test NPC with two keywords
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var kw1 = Mutagen.Bethesda.Plugins.FormKey.Factory("000010:Fallout4.esm");
        var kw2 = Mutagen.Bethesda.Plugins.FormKey.Factory("000020:Fallout4.esm");
        npc.Keywords = [
            new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IKeywordGetter>(kw1),
            new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IKeywordGetter>(kw2),
        ];

        var result = col.Extract(npc);
        Assert.NotNull(result);
        var json = Assert.IsType<string>(result);
        var parsed = System.Text.Json.JsonSerializer.Deserialize<List<string>>(json);
        Assert.NotNull(parsed);
        Assert.Equal(2, parsed.Count);
        Assert.Contains(kw1.ToString(), parsed);
        Assert.Contains(kw2.ToString(), parsed);
    }

    [Fact]
    public void GetSchemas_Npc_Keywords_Extract_WhenNull_ReturnsNull()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "keywords");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Test.esp"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            Keywords = null
        };
        Assert.Null(col.Extract(npc));
    }

    // ── ToSnakeCase ────────────────────────────────────────────────────────────

    [Fact]
    public void ToSnakeCase_WordBoundary_InsertsUnderscore()
    {
        Assert.Equal("aggro_radius", ReflectedTypes.ToSnakeCase("AggroRadius"));
    }

    [Fact]
    public void ToSnakeCase_SingleWord_LowercasesOnly()
    {
        Assert.Equal("name", ReflectedTypes.ToSnakeCase("Name"));
    }

    [Fact]
    public void ToSnakeCase_MultipleWordBoundaries_AllConverted()
    {
        Assert.Equal("aggro_radius_behavior_enabled", ReflectedTypes.ToSnakeCase("AggroRadiusBehaviorEnabled"));
    }

    [Fact]
    public void ToSnakeCase_AlreadyLowercase_Unchanged()
    {
        Assert.Equal("name", ReflectedTypes.ToSnakeCase("name"));
    }

    // ── Float column ──────────────────────────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_FloatColumn_HasFloatDuckDbAndApiType()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "height_min");
        Assert.NotNull(col);
        Assert.Equal("FLOAT", col.DuckDbType);
        Assert.Equal("float", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_FloatColumn_Extract_ReturnsCurrentValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "height_min");
        Assert.NotNull(col);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            HeightMin = 1.5f
        };

        var result = col.Extract(npc);
        Assert.Equal(1.5f, result);
    }

    [Fact]
    public void GetSchemas_Npc_FloatColumn_Apply_ChangesValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "height_min");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply.Writer);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            HeightMin = 1.0f
        };

        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("2.5").RootElement);

        Assert.Equal(2.5f, npc.HeightMin, precision: 3);

        // MakeApplier's JSON-null success branch is shared live infrastructure reached by every
        // nullable scalar column, and is otherwise unexercised.
        var nullableCol = schemas["npc_"].RecordColumns.First(c => c.Name == "facial_morph_intensity");
        Assert.NotNull(nullableCol.Apply.Writer); // the delegate, not the always-present wrapper
        npc.FacialMorphIntensity = 1.0f;

        nullableCol.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("null").RootElement);

        Assert.Null(npc.FacialMorphIntensity);
    }

    // ── Factions (struct array) extraction ────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Factions_Extract_ProducesJsonWithFactionAndRank()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var factionKey = Mutagen.Bethesda.Plugins.FormKey.Factory("000002:Fallout4.esm");
        npc.Factions.Add(new Mutagen.Bethesda.Fallout4.RankPlacement
        {
            Faction = new Mutagen.Bethesda.Plugins.FormLink<Mutagen.Bethesda.Fallout4.IFactionGetter>(factionKey),
            Rank = 5,
        });

        var result = col.Extract(npc);
        Assert.NotNull(result);
        var json = Assert.IsType<string>(result);
        var items = System.Text.Json.JsonSerializer.Deserialize<List<Dictionary<string, System.Text.Json.JsonElement>>>(json);
        Assert.NotNull(items);
        Assert.Single(items);
        Assert.Equal(factionKey.ToString(), items[0]["faction"].GetString());
        Assert.Equal(5, items[0]["rank"].GetInt32());
    }

    // ── Array Apply ───────────────────────────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_Apply_ReplacesKeywordList()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply.Writer);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var kw1 = Mutagen.Bethesda.Plugins.FormKey.Factory("000010:Fallout4.esm");
        var kw2 = Mutagen.Bethesda.Plugins.FormKey.Factory("000020:Fallout4.esm");

        var json = $"[\"{kw1}\",\"{kw2}\"]";
        // An array-shaped payload is written, and says so — the other side of the shape guard.
        Assert.Equal(ApplyOutcome.Applied, col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse(json).RootElement));

        Assert.NotNull(npc.Keywords);
        Assert.Equal(2, npc.Keywords!.Count);
        var appliedKeys = npc.Keywords.Select(k => ((Mutagen.Bethesda.Plugins.IFormLinkGetter)k).FormKey).ToList();
        Assert.Contains(kw1, appliedKeys);
        Assert.Contains(kw2, appliedKeys);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Apply_UpdatesFactionList()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "factions");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply.Writer);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var factionKey = Mutagen.Bethesda.Plugins.FormKey.Factory("000003:Fallout4.esm");
        var json = $"[{{\"faction\":\"{factionKey}\",\"rank\":7}}]";

        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse(json).RootElement);

        Assert.Single(npc.Factions);
        Assert.Equal(7, npc.Factions[0].Rank);
        Assert.Equal(factionKey, npc.Factions[0].Faction.FormKey);
    }

    // ── IsFormLink requires both IsInterface AND IsGenericType ─────────────────

    [Fact]
    public void GetSchemas_Npc_Factions_Apply_NonArrayJson_DoesNothing()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "factions");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        // "Does nothing" is only half of it — the applier has to *say* it wrote nothing, or the
        // write path reports the edit as applied and the user's change vanishes silently.
        var applied = col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("\"notanarray\"").RootElement);

        Assert.Equal(ApplyOutcome.ValueRejected, applied);
        Assert.Empty(npc.Factions);
    }

    [Fact]
    public void GetSchemas_Npc_Weight_IsStructNotFormkey()
    {
        // INpcWeightGetter is a non-generic interface. If IsFormLink required only IsInterface
        // rather than IsInterface && IsGenericType, it would classify as a formkey column.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
    }

    // ── Null list returns null from Extract ────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_Extract_ReturnsNullWhenKeywordsNotSet()
    {
        // A freshly created NPC has Keywords = null. The extractor should return null,
        // not call SerializeListItems on a null IEnumerable.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "keywords");
        Assert.NotNull(col);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        var result = col.Extract(npc);
        Assert.Null(result);
    }

    // ── Loqui scalar Apply: applies JSON object to struct sub-field ───────────────

    [Fact]
    public void GetSchemas_Npc_Weight_Apply_UpdatesSubFields()
    {
        // The weight column holds INpcWeightGetter (a Loqui scalar). Apply should
        // deserialise a JSON object and write each primitive sub-field back via
        // the sub-field Apply delegates (the Loqui scalar Apply path).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply.Writer);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        var json = """{"thin":0.5,"fat":0.8,"muscular":0.3}""";
        // An object-shaped payload is written, and says so — the other side of the shape guard.
        Assert.Equal(ApplyOutcome.Applied, col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse(json).RootElement));

        Assert.NotNull(npc.Weight);
        Assert.Equal(0.5f, npc.Weight!.Thin, precision: 3);
        Assert.Equal(0.8f, npc.Weight.Fat, precision: 3);
        Assert.Equal(0.3f, npc.Weight.Muscular, precision: 3);
    }

    [Fact]
    public void GetSchemas_Npc_Weight_Apply_NonObjectJson_DoesNothing()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "weight");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var originalWeight = npc.Weight;

        // The struct half of the same rule: a non-object payload is reported as not written.
        var applied = col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("[1,2,3]").RootElement);

        Assert.Equal(ApplyOutcome.ValueRejected, applied);
        Assert.Equal(originalWeight, npc.Weight);
    }

    [Fact]
    public void GetSchemas_Npc_Weight_Apply_PreservesExistingSubFieldValues()
    {
        // When Weight is non-null, Apply must use the existing instance (rp.GetValue),
        // not a fresh CreateInstance — so non-applied sub-fields keep their original values.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "weight");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            Weight = new Mutagen.Bethesda.Fallout4.NpcWeight { Thin = 0.9f, Fat = 0.1f, Muscular = 0.2f }
        };

        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("{\"thin\":0.5}").RootElement);

        Assert.NotNull(npc.Weight);
        Assert.Equal(0.5f, npc.Weight!.Thin, precision: 3);
        Assert.Equal(0.1f, npc.Weight.Fat, precision: 3);
        Assert.Equal(0.2f, npc.Weight.Muscular, precision: 3);
    }

    // ── ulong column: TryMapPrimitive BIGINT path ────────────────────────────────

    [Fact]
    public void GetSchemas_ImageSpaceAdapter_UInt64Column_MapsToBigInt()
    {
        // IImageSpaceAdapterGetter has a UInt64 Unknown field — exercises the ulong branch
        // in TryMapPrimitive (maps to BIGINT / "int").
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["imad"].RecordColumns.FirstOrDefault(c => c.Name == "unknown");
        Assert.NotNull(col);
        Assert.Equal("BIGINT", col.DuckDbType);
        Assert.Equal("int", col.ApiType);
    }

    // ── Primitive type parity: GetColumnInfo and GetSubFieldInfo cover the same types ──
    //
    // A refactor dropping a type from one chain but not the other fails the sub-field assertion.

    [Theory]
    [InlineData("height_min", "float", "FLOAT", "weight", false, "thin")]
    [InlineData("xp_value_offset", "int", "INTEGER", "factions", true, "rank")]
    [InlineData("race", "formKey", "VARCHAR", "factions", true, "faction")]
    [InlineData("aggression", "enum", "VARCHAR", "face_tinting_layers", true, "data_type")]
    public void GetSchemas_PrimitiveType_ColumnAndSubFieldBothReflected(
        string topLevelColumnName,
        string expectedApiType,
        string expectedDuckDbType,
        string structOrArrayColumn,
        bool isArray,
        string subFieldName)
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var npc = schemas["npc_"];

        var topCol = npc.RecordColumns.FirstOrDefault(c => c.Name == topLevelColumnName);
        Assert.NotNull(topCol);
        Assert.Equal(expectedApiType, topCol!.ApiType);
        Assert.Equal(expectedDuckDbType, topCol.DuckDbType);

        var structCol = npc.RecordColumns.FirstOrDefault(c => c.Name == structOrArrayColumn);
        Assert.NotNull(structCol);

        IReadOnlyList<MEditService.Core.Queries.FieldMetadata>? subFields = isArray
            ? structCol!.ElementType?.Fields
            : structCol!.SubFields;

        Assert.NotNull(subFields);
        var subField = subFields!.FirstOrDefault(f => f.Name == subFieldName);
        Assert.NotNull(subField);
        Assert.Equal(expectedApiType, subField!.Type);
    }

    [Fact]
    public void Extract_NullableListProperty_ReturnsNullInsteadOfThrowing()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var perksCol = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "perks");
        Assert.NotNull(perksCol);

        var npc = new Npc(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var result = perksCol!.Extract(npc);

        Assert.Null(result);
    }

    [Fact]
    public void Extract_ScalarListProperty_ReturnsJsonArray()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["must"].RecordColumns.FirstOrDefault(c => c.Name == "cue_points");
        Assert.NotNull(col);

        var track = new MusicTrack(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4)
        {
            CuePoints = [1.0f, 2.5f]
        };

        var result = col!.Extract(track) as string;

        Assert.NotNull(result);
        Assert.Contains("1", result);
        Assert.Contains("2.5", result);
    }

    [Fact]
    public void Extract_StructProperty_NullValue_ReturnsNull()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);

        var npc = new Npc(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var result = col!.Extract(npc);

        Assert.Null(result);
    }

    [Fact]
    public void Extract_StructProperty_NonNullValue_ReturnsJsonString()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);

        var npc = new Npc(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4)
        {
            Weight = new NpcWeight { Thin = 0.1f, Muscular = 0.2f, Fat = 0.3f }
        };

        var result = col!.Extract(npc) as string;

        Assert.NotNull(result);
        Assert.Contains("thin", result);
    }

    // ── Bitmask / [Flags] enum support ────────────────────────────

    [Fact]
    public void GetSchemas_Npc_FlagColumn_IsBitmaskTrue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "flags");
        Assert.NotNull(col);
        Assert.True(col!.IsBitmask);
        Assert.Equal("BIGINT", col.DuckDbType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_IsBitmaskFalse()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(col);
        Assert.False(col!.IsBitmask);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_MembersCarryNoBit()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(col);
        Assert.All(col!.EnumMembers, m => Assert.Null(m.BitValue));
    }

    [Fact]
    public void GetSchemas_FlagColumn_EveryMemberCarriesAnAtomicBit()
    {
        // GetEnumMembers must filter out None=0 and composite values — only atomic power-of-two bits
        // should appear.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "flags");
        Assert.NotNull(col);
        Assert.NotEmpty(col!.EnumMembers);
        Assert.All(col.EnumMembers, m =>
        {
            Assert.NotNull(m.BitValue);
            long v = long.Parse(m.BitValue!, System.Globalization.CultureInfo.InvariantCulture);
            Assert.True(v > 0 && (v & (v - 1)) == 0, $"Expected a power-of-two bit value, got {m.BitValue}");
        });
    }

    [Fact]
    public void GetSchemas_Race_FlagColumn_HighBitValues_SerializedAsStrings()
    {
        // Race.Flag is ulong-backed with LowPriorityPushable = 2^53 and
        // CannotUsePlayableItems = 2^54 — both beyond JS Number MAX_SAFE_INTEGER.
        // A member's BitValue must be string so the frontend can parse it as BigInt.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["race"].RecordColumns.Single(c => c.Name == "flags");
        var bits = col.EnumMembers.Select(m => m.BitValue).ToList();
        Assert.Contains("9007199254740992", bits);   // LowPriorityPushable = 2^53
        Assert.Contains("18014398509481984", bits);  // CannotUsePlayableItems = 2^54
        Assert.Contains("1", bits);                   // Playable (low-bit sanity check)
    }

    [Fact]
    public void GetSchemas_Race_FlagColumn_Apply_AcceptsHighBitDecimalString()
    {
        // Bitmask edits arrive from the frontend as decimal strings so values above 2^53
        // survive JSON. Apply must parse the string token, not throw on it (GetInt64 would).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["race"].RecordColumns.Single(c => c.Name == "flags");
        Assert.NotNull(col.Apply.Writer);

        var race = new Mutagen.Bethesda.Fallout4.Race(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        col.Apply.Writer!(race, System.Text.Json.JsonDocument.Parse("\"9007199254740993\"").RootElement);

        Assert.Equal(9007199254740993UL, (ulong)race.Flags);
    }

    [Fact]
    public void GetSchemas_Npc_FlagColumn_Apply_AcceptsNumberToken()
    {
        // Legacy numeric tokens (values below 2^53) must still apply.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.Single(c => c.Name == "flags");
        Assert.NotNull(col.Apply.Writer);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var bit = long.Parse(col.EnumMembers[0].BitValue!, System.Globalization.CultureInfo.InvariantCulture);

        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse(bit.ToString(System.Globalization.CultureInfo.InvariantCulture)).RootElement);

        Assert.Equal((ulong)bit, (ulong)npc.Flags);
    }

    [Fact]
    public void GetSchemas_Misc_CompositeFlagsEnum_IsNotBitmask()
    {
        // MiscItem.MajorFlag has [Flags] but CalcFromComponents=11 and PackInUseOnly=13 —
        // both non-power-of-two. GetEnumMembers must fall back to plain-enum treatment.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("misc"), "misc schema must be present");
        var col = schemas["misc"].RecordColumns.FirstOrDefault(c => c.Name == "major_flags");
        Assert.NotNull(col);
        Assert.False(col!.IsBitmask);
        Assert.All(col.EnumMembers, m => Assert.Null(m.BitValue));
    }

    // ── Plugin header as a first-class record ─────────────────────────────────
    // ModHeader is not a major record in Mutagen (no FormKey or EditorID), so it cannot be discovered
    // by the major-record-getter scan and gets one hand-assembled schema entry instead.

    [Fact]
    public void GetSchemas_ContainsHeaderTable()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("header"));
    }

    [Fact]
    public void GetSchemas_Header_AuthorColumn_IsStringType()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "author");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col!.DuckDbType);
        Assert.Equal("string", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Header_FlagsColumn_IsBitmaskEnumWithEsmAndEslNames()
    {
        // Header flags display xEdit's vocabulary, not raw Mutagen member names.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "flags");
        Assert.NotNull(col);
        Assert.Equal("BIGINT", col!.DuckDbType);
        Assert.Equal("enum", col.ApiType);
        Assert.True(col.IsBitmask);
        var values = col.EnumMembers.Select(m => m.Value).ToList();
        Assert.Contains("ESM", values);
        Assert.DoesNotContain("Master", values);
        Assert.Contains("ESL", values);
        Assert.DoesNotContain("Small", values);
        Assert.Contains("Localized", values);

        // Renaming for display must leave each member holding its own bit.
        Assert.Equal("1", col.EnumMembers.Single(m => m.Value == "ESM").BitValue);
        Assert.Equal(
            ((long)Mutagen.Bethesda.Fallout4.Fallout4ModHeader.HeaderFlag.Small).ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            col.EnumMembers.Single(m => m.Value == "ESL").BitValue);
    }

    [Theory]
    [InlineData("LightMaster", "ESL")]
    [InlineData("Light", "ESL")]
    [InlineData("Small", "ESL")]
    [InlineData("Master", "ESM")]
    [InlineData("Overlay", "Overlay")]
    [InlineData("Localized", "Localized")]
    public void MapToXEditFlagName_KeysOffMutagenMemberName_NotBitPosition(string mutagenName, string expected)
    {
        // Only Fallout4 is referenced here, so a live second-game schema is not reflectable: this exercises
        // the mapping against every Mutagen member name it keys off, proving it is keyed by name rather
        // than bit position.
        Assert.Equal(expected, ModHeaderSchema.MapToXEditFlagName(mutagenName));
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_IsArrayOfString()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "masters");
        Assert.NotNull(col);
        Assert.Equal("array", col!.ApiType);
        Assert.NotNull(col.ElementType);
        Assert.Equal("string", col.ElementType!.Type);
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_ToFieldMetadata_IsArrayTrue()
    {
        // The column itself must be flagged as an array (not just ApiType == "array") — this is
        // what the frontend's array rows key off to render masters as a repeatable list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.Single(c => c.Name == "masters");
        Assert.True(col.ToFieldMetadata().IsArray);
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_ElementType_IsNotItselfAnArray()
    {
        // Each master is a single plugin-filename string, not a nested array — the element
        // FieldMetadata's own IsArray must be false, or the frontend would try to render each
        // master entry as a further repeatable list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.Single(c => c.Name == "masters");
        Assert.NotNull(col.ElementType);
        Assert.False(col.ElementType!.IsArray);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnExtract_HasOneDelegatePerColumnInOrder()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["header"];
        Assert.NotNull(schema.HeaderColumnExtract);
        Assert.Equal(schema.RecordColumns.Count, schema.HeaderColumnExtract!.Count);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnExtract_AuthorReadsModHeaderAuthor()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["header"];
        var authorIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "author");

        var mod = new Mutagen.Bethesda.Fallout4.Fallout4Mod(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("Test.esp"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Some Author";

        var value = schema.HeaderColumnExtract![authorIndex]((Mutagen.Bethesda.Plugins.Records.IModGetter)mod);
        Assert.Equal("Some Author", value);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnExtract_FlagsReadsModHeaderFlags()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["header"];
        var flagsIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "flags");

        var mod = new Mutagen.Bethesda.Fallout4.Fallout4Mod(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("Test.esp"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        mod.ModHeader.Flags = Mutagen.Bethesda.Fallout4.Fallout4ModHeader.HeaderFlag.Small;

        var value = schema.HeaderColumnExtract![flagsIndex]((Mutagen.Bethesda.Plugins.Records.IModGetter)mod);
        Assert.Equal((long)Mutagen.Bethesda.Fallout4.Fallout4ModHeader.HeaderFlag.Small,
            Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnExtract_MastersReadsPluginFilenamesInOrder()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["header"];
        var mastersIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "masters");

        var mod = new Mutagen.Bethesda.Fallout4.Fallout4Mod(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("Test.esp"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.Add(new Mutagen.Bethesda.Plugins.Records.MasterReference
        {
            Master = Mutagen.Bethesda.Plugins.ModKey.FromFileName("Fallout4.esm"),
        });
        mod.ModHeader.MasterReferences.Add(new Mutagen.Bethesda.Plugins.Records.MasterReference
        {
            Master = Mutagen.Bethesda.Plugins.ModKey.FromFileName("DLCRobot.esm"),
        });

        var value = schema.HeaderColumnExtract![mastersIndex]((Mutagen.Bethesda.Plugins.Records.IModGetter)mod) as string;
        Assert.NotNull(value);
        var parsed = System.Text.Json.JsonSerializer.Deserialize<List<string>>(value);
        Assert.Equal(["Fallout4.esm", "DLCRobot.esm"], parsed);
    }

    [Fact]
    public void GetSchemas_Header_RecordType_IsHeaderGetterInterface_NotAMajorRecordType()
    {
        // Guards against the header schema ever being routed through the major-record
        // indexing loop (EnumerateMajorRecords), which assumes an IMajorRecordGetter.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["header"];
        Assert.False(typeof(Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter).IsAssignableFrom(schema.RecordType));
    }

    // ── Condition lists are ordinary reflected array columns ──
    //
    // Perk.Conditions reaches the record editor through the same array-of-struct column every list of
    // Loqui structs does. Perk.Effects is paired here as the neighbouring list-of-struct.

    [Fact]
    public void GetSchemas_Perk_ConditionsProperty_IsAGenericArrayColumn()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["perk"].RecordColumns;
        Assert.Contains(columns, c => c.Name == "conditions" && c.ApiType == "array");
    }

    [Fact]
    public void GetSchemas_Perk_EffectsProperty_StillGetsGenericArrayColumn()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["perk"].RecordColumns;
        Assert.Contains(columns, c => c.Name == "effects" && c.ApiType == "array");
    }

    // ── P3Int16/P3Float leaf coverage ──────────────────────────────────────────

    [Fact]
    public void GetSchemas_Container_HasObjectBoundsColumn_WithFirstSecondXyzSubFields()
    {
        // ObjectBounds.First/Second are Noggog.P3Int16, a mapping neither makes BuildStructColumn drop the
        // whole column for having no sub-fields. xEdit renders six individually-named int16 members
        // (wbDefinitionsCommon.pas: wbOBND), not one opaque value.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.FirstOrDefault(c => c.Name == "object_bounds");
        Assert.NotNull(col);
        Assert.Equal("struct", col!.ApiType);

        var first = col.SubFields?.FirstOrDefault(f => f.Name == "first");
        Assert.NotNull(first);
        Assert.Equal("struct", first!.Type);
        Assert.Contains(first.Fields!, f => f.Name == "x" && f.Type == "int");
        Assert.Contains(first.Fields!, f => f.Name == "y" && f.Type == "int");
        Assert.Contains(first.Fields!, f => f.Name == "z" && f.Type == "int");

        var second = col.SubFields?.FirstOrDefault(f => f.Name == "second");
        Assert.NotNull(second);
        Assert.Equal("struct", second!.Type);
        Assert.Contains(second.Fields!, f => f.Name == "x" && f.Type == "int");
        Assert.Contains(second.Fields!, f => f.Name == "y" && f.Type == "int");
        Assert.Contains(second.Fields!, f => f.Name == "z" && f.Type == "int");
    }

    [Fact]
    public void GetSchemas_Container_ObjectBounds_Extract_ReturnsFirstSecondXyzValues()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "object_bounds");
        var container = new Container(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4)
        {
            ObjectBounds = new ObjectBounds
            {
                First = new Noggog.P3Int16(1, 2, 3),
                Second = new Noggog.P3Int16(4, 5, 6),
            },
        };

        var json = col.Extract(container) as string;
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json!);
        Assert.Equal(1, doc.RootElement.GetProperty("first").GetProperty("x").GetInt32());
        Assert.Equal(2, doc.RootElement.GetProperty("first").GetProperty("y").GetInt32());
        Assert.Equal(3, doc.RootElement.GetProperty("first").GetProperty("z").GetInt32());
        Assert.Equal(4, doc.RootElement.GetProperty("second").GetProperty("x").GetInt32());
        Assert.Equal(5, doc.RootElement.GetProperty("second").GetProperty("y").GetInt32());
        Assert.Equal(6, doc.RootElement.GetProperty("second").GetProperty("z").GetInt32());
    }

    [Fact]
    public void GetSchemas_Container_ObjectBounds_Apply_WritesFirstSecondXyz()
    {
        // The rival this defeats: a P3Int16 sub-field built with a null Apply makes ApplySubFields
        // silently skip "first"/"second", so the whole object_bounds Apply still reports Applied
        // while ObjectBounds never changed.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "object_bounds");
        var container = new Container(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var json = """{"first":{"x":1,"y":2,"z":3},"second":{"x":4,"y":5,"z":6}}""";
        var outcome = col.Apply.Writer!(container, JsonDocument.Parse(json).RootElement);

        Assert.Equal(ApplyOutcome.Applied, outcome);
        Assert.Equal((short)1, container.ObjectBounds.First.X);
        Assert.Equal((short)2, container.ObjectBounds.First.Y);
        Assert.Equal((short)3, container.ObjectBounds.First.Z);
        Assert.Equal((short)4, container.ObjectBounds.Second.X);
        Assert.Equal((short)5, container.ObjectBounds.Second.Y);
        Assert.Equal((short)6, container.ObjectBounds.Second.Z);
    }

    [Fact]
    public void GetSchemas_Container_ObjectBounds_Apply_NonObjectJson_DoesNothing()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "object_bounds");
        var container = new Container(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);
        var original = container.ObjectBounds;

        var outcome = col.Apply.Writer!(container, JsonDocument.Parse("[1,2,3]").RootElement);

        Assert.Equal(ApplyOutcome.ValueRejected, outcome);
        Assert.Equal(original.First, container.ObjectBounds.First);
        Assert.Equal(original.Second, container.ObjectBounds.Second);
    }

    // ── Nested list inside a struct (Destructible.Resistances/Stages) ──────────

    [Fact]
    public void GetSchemas_Container_Destructible_HasResistancesAndStagesArraySubFields()
    {
        // Without GetSubFieldInfo's IsListType arm, both silently drop from
        // Destructible's own sub-schema — "data" (Destructible's other, already-mappable member)
        // stays present regardless, which is why this can't just check the column exists.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var destructible = schemas["cont"].RecordColumns.First(c => c.Name == "destructible");

        var resistances = destructible.SubFields?.FirstOrDefault(f => f.Name == "resistances");
        Assert.NotNull(resistances);
        Assert.Equal("array", resistances!.Type);
        Assert.True(resistances.IsArray);

        var stages = destructible.SubFields?.FirstOrDefault(f => f.Name == "stages");
        Assert.NotNull(stages);
        Assert.Equal("array", stages!.Type);
        Assert.True(stages.IsArray);
        Assert.Contains(stages.ElementType!.Fields!, f => f.Name == "health_percent");
    }

    [Fact]
    public void GetSchemas_Container_Destructible_Apply_WritesStagesArray()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "destructible");
        var container = new Container(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var json = """{"stages":[{"health_percent":50}]}""";
        var outcome = col.Apply.Writer!(container, JsonDocument.Parse(json).RootElement);

        Assert.Equal(ApplyOutcome.Applied, outcome);
        Assert.NotNull(container.Destructible);
        Assert.Single(container.Destructible!.Stages);
        Assert.Equal(50, container.Destructible.Stages[0].HealthPercent);
    }

    [Fact]
    public void GetSchemas_Container_Destructible_Extract_StagesNestAsARealArray_NotAnEscapedString()
    {
        // BuildListSubField's Extract must return the raw object graph, so it composes under the
        // enclosing struct's single Serialize pass.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "destructible");
        var container = new Container(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4)
        {
            Destructible = new Destructible(),
        };
        container.Destructible!.Stages.Add(new DestructionStage { HealthPercent = 50 });

        var json = col.Extract(container) as string;
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json!);
        var stages = doc.RootElement.GetProperty("stages");

        Assert.Equal(JsonValueKind.Array, stages.ValueKind);
        Assert.Equal(50, stages[0].GetProperty("health_percent").GetInt32());
    }

    // ── P3Float, both dispatch paths, on fixtures with no side-table mirror ────────────────────

    [Fact]
    public void GetSchemas_MaterialObject_HasProjectionVectorColumn_WithXyzSubFields()
    {
        // MaterialObject.ProjectionVector is a direct top-level P3Float column (GetColumnInfo path)
        // with no side-table mirror — unlike Placed*.Position (see the RecordEditService companion
        // refusal), safe to make writable unconditionally.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["mato"].RecordColumns.FirstOrDefault(c => c.Name == "projection_vector");
        Assert.NotNull(col);
        Assert.Equal("struct", col!.ApiType);
        Assert.Contains(col.SubFields!, f => f.Name == "x" && f.Type == "float");
        Assert.Contains(col.SubFields!, f => f.Name == "y" && f.Type == "float");
        Assert.Contains(col.SubFields!, f => f.Name == "z" && f.Type == "float");
    }

    [Fact]
    public void GetSchemas_MaterialObject_ProjectionVector_Apply_WritesXyz()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["mato"].RecordColumns.First(c => c.Name == "projection_vector");
        var mato = new MaterialObject(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var outcome = col.Apply.Writer!(mato, JsonDocument.Parse("""{"x":1.5,"y":2.5,"z":3.5}""").RootElement);

        Assert.Equal(ApplyOutcome.Applied, outcome);
        Assert.Equal(1.5f, mato.ProjectionVector.X, precision: 3);
        Assert.Equal(2.5f, mato.ProjectionVector.Y, precision: 3);
        Assert.Equal(3.5f, mato.ProjectionVector.Z, precision: 3);
    }

    [Fact]
    public void GetSchemas_PlacedObject_TeleportDestination_HasPositionRotationXyzSubFields()
    {
        // PlacedObject.TeleportDestination.Position/Rotation — P3Float nested one level inside a
        // struct (GetSubFieldInfo path), never mirrored anywhere else, so safe unconditionally too.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var teleport = schemas["refr"].RecordColumns.FirstOrDefault(c => c.Name == "teleport_destination");
        Assert.NotNull(teleport);

        var position = teleport!.SubFields?.FirstOrDefault(f => f.Name == "position");
        Assert.NotNull(position);
        Assert.Equal("struct", position!.Type);
        Assert.Contains(position.Fields!, f => f.Name == "x" && f.Type == "float");
        Assert.Contains(position.Fields!, f => f.Name == "y" && f.Type == "float");
        Assert.Contains(position.Fields!, f => f.Name == "z" && f.Type == "float");

        var rotation = teleport.SubFields?.FirstOrDefault(f => f.Name == "rotation");
        Assert.NotNull(rotation);
        Assert.Equal("struct", rotation!.Type);
    }

    // ── Noggog's small value-vector struct family, beyond P3Int16/P3Float ──────────────────────

    [Fact]
    public void GetSchemas_Cell_HasGridColumn_WithFlagsAndPointXySubFields()
    {
        // Cell.Grid.Point is a Noggog.P2Int, which a ClassifyLeaf limited to P3Int16/P3Float maps
        // not at all.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cell"].RecordColumns.FirstOrDefault(c => c.Name == "grid");
        Assert.NotNull(col);
        Assert.Equal("struct", col!.ApiType);
        Assert.Equal(2, col.SubFields!.Count);

        Assert.Contains(col.SubFields!, f => f.Name == "flags" && f.Type == "enum");

        var point = col.SubFields!.FirstOrDefault(f => f.Name == "point");
        Assert.NotNull(point);
        Assert.Equal("struct", point!.Type);
        Assert.Equal(2, point.Fields!.Count);
        Assert.Contains(point.Fields!, f => f.Name == "x" && f.Type == "int");
        Assert.Contains(point.Fields!, f => f.Name == "y" && f.Type == "int");
    }

    [Fact]
    public void GetSchemas_Cell_Grid_Extract_ReturnsPointXyValues()
    {
        // The read side: without Point as a recognized sub-field, Grid's Extract omits it from the JSON
        // entirely, because ExtractSubObject only walks recognized sub-fields.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cell"].RecordColumns.First(c => c.Name == "grid");
        var cell = new Cell(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4)
        {
            Grid = new CellGrid { Point = new Noggog.P2Int(3, -4) },
        };

        var json = col.Extract(cell) as string;
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json!);
        Assert.Equal(3, doc.RootElement.GetProperty("point").GetProperty("x").GetInt32());
        Assert.Equal(-4, doc.RootElement.GetProperty("point").GetProperty("y").GetInt32());
    }

    [Fact]
    public void GetSchemas_Location_WorldspaceCellsAdded_ElementHasCoordinatesListOfXYSubFields()
    {
        // LocationCoordinate.Coordinates is a list nested inside a struct that is itself a list
        // element, composing the struct-nested-list arm with the widened vector-struct set.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["lctn"].RecordColumns.FirstOrDefault(c => c.Name == "worldspace_cells_added");
        Assert.NotNull(col);
        Assert.Equal("array", col!.ApiType);

        var coordinates = col.ElementType?.Fields?.FirstOrDefault(f => f.Name == "coordinates");
        Assert.NotNull(coordinates);
        Assert.True(coordinates!.IsArray);
        Assert.Equal(2, coordinates.ElementType!.Fields!.Count);
        Assert.Contains(coordinates.ElementType.Fields!, f => f.Name == "x" && f.Type == "int");
        Assert.Contains(coordinates.ElementType.Fields!, f => f.Name == "y" && f.Type == "int");
    }

    [Fact]
    public void GetSchemas_Location_WorldspaceCellsAdded_Extract_ReturnsCoordinatesXyValues()
    {
        // The rival this defeats: widening ClassifyLeaf's dispatch alone, leaving BuildListColumn's
        // isVector flag on the narrower set, lets a list-of-P2Int16 element fall through to the
        // unmapped scalar-element fallback.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["lctn"].RecordColumns.First(c => c.Name == "worldspace_cells_added");
        var location = new Location(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4)
        {
            WorldspaceCellsAdded = new Noggog.ExtendedList<LocationCoordinate>
            {
                new() { Coordinates = new Noggog.ExtendedList<Noggog.P2Int16> { new(5, 6), new(7, 8) } },
            },
        };

        var json = col.Extract(location) as string;
        Assert.NotNull(json);
        using var doc = JsonDocument.Parse(json!);
        var coords = doc.RootElement[0].GetProperty("coordinates");
        Assert.Equal(5, coords[0].GetProperty("x").GetInt32());
        Assert.Equal(6, coords[0].GetProperty("y").GetInt32());
        Assert.Equal(7, coords[1].GetProperty("x").GetInt32());
        Assert.Equal(8, coords[1].GetProperty("y").GetInt32());
    }
}
