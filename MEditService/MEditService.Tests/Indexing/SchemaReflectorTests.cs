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
    private readonly ISchemaReflector _reflector = SharedSchemaReflector.Instance;

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
        // Phase 16: placed objects are indexed as normal records so the worldspace tree,
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

    // ── Issue #179: VMAD capability gate ───────────────────────────────────────

    [Fact]
    public void GetSchemas_Cmpo_HasVmad_IsFalse()
    {
        // CMPO ("Component") has no VMAD subrecord per xEdit's format definition
        // (wbDefinitionsFO4.pas) — Component_Generated.cs doesn't implement
        // IHaveVirtualMachineAdapterGetter, so the schema-level flag must be false.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.False(schemas["cmpo"].HasVmad);
    }

    [Fact]
    public void GetSchemas_Npc_HasVmad_IsTrue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas["npc_"].HasVmad);
    }

    // ── Issue #260: VMAD is surfaced once, by the Scripts (VMAD) section ────────

    [Fact]
    public void GetSchemas_Npc_VirtualMachineAdapterProperty_ExcludedFromGenericColumns()
    {
        // Npc.VirtualMachineAdapter is already surfaced by the dedicated Scripts (VMAD) section
        // (HasVmad above) — reflecting it again here would duplicate it as a plain struct column.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["npc_"].RecordColumns;
        Assert.DoesNotContain(columns, c => c.Name == "virtual_machine_adapter");
    }

    [Fact]
    public void GetSchemas_Cmpo_NoVmadInterface_RecordColumnsUnaffectedByVmadExclusion()
    {
        // AC3: pins that a record type without VMAD (Component/CMPO, see GetSchemas_Cmpo_HasVmad_IsFalse
        // above) keeps its ordinary columns (AutoCalcValue) and has no `virtual_machine_adapter` one.
        // This does not, and cannot, distinguish the type-scoped exclusion from a name-only one: CMPO
        // never had a VirtualMachineAdapter property to begin with, so both shapes pass here vacuously
        // (confirmed by deleting the type-scoping `.Where` entirely — only the npc_ test above goes
        // red). It's a characterization guard against a future filter of some other shape, not a test
        // of the type-scoping itself.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["cmpo"].RecordColumns;
        Assert.DoesNotContain(columns, c => c.Name == "virtual_machine_adapter");
        Assert.Contains(columns, c => c.Name == "auto_calc_value");
    }

    // ── Issue #110: xEdit-parity display names ────────────────────────────────

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

    // ── Issue #263: GMST/GLOB's Data column is backed by several concrete Mutagen subclasses,
    // discriminated per record (the EditorID's leading i/f/s/b/u), not per table — schema
    // discovery used to pick one subclass's Data property and silently drop the rest, so every
    // GameSetting of any other type read back with no value. ────────────────────────────────

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
        // not the raw boxed value, so the column round-trips through AppendTyped's VARCHAR branch
        // (a bare ToString(), see AppendTyped) the same way on every host.
        Assert.Equal("42", data.Extract(i));
        Assert.Equal("3.5", data.Extract(f));
        Assert.Equal("hello", data.Extract(s));
        Assert.Equal("true", data.Extract(b));
    }

    [Fact]
    public void GetSchemas_Gmst_DataColumn_WidenedFloatFormattingIsCultureInvariant()
    {
        // Regression: FormatWidenedValue used to hand a raw boxed float straight through to
        // AppendTyped's VARCHAR branch, whose value.ToString() carries no culture — the first
        // VARCHAR column to ever hold a raw numeric rather than an already-formatted string. Under
        // a comma-decimal culture that round-tripped 3.5 as "3,5", defeating AC1/AC2 (the ticket's
        // whole point) on any non-en-US host. Setting CurrentCulture for the assertion is what
        // makes this fail without the fix regardless of which machine runs it — a test that only
        // passes on the machine that wrote it is how the original bug got through.
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
        // #365 mutation-triage gap: GetSchemas_Gmst_DataColumn_ExtractsCorrectValuePerSubclass above
        // only ever asserts Data = true for GameSettingBool, so FormatWidenedValue's bool branch has
        // never been exercised with a false input — a mutant collapsing `b ? "true" : "false"` to
        // always "true" survived undetected. This closes that gap directly, not through the "one of
        // each subclass" test above (whose point is per-subclass dispatch, not this specific value).
        var mod = new Fallout4Mod(ModKey.FromFileName("Gmst365BoolFalse.esp"), Fallout4Release.Fallout4);
        var b = new GameSettingBool(mod.GetNextFormKey("bFalseTest"), Fallout4Release.Fallout4) { EditorID = "bFalseTest", Data = false };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var data = schemas["gmst"].RecordColumns.Single(c => c.Name == "data");

        Assert.Equal("false", data.Extract(b));
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_KeepsStructuredArrayShape_NotWidened()
    {
        // #339: OMOD's Properties is the same per-subclass-typed shape as GMST/GLOB's Data, but on
        // a list (each of ArmorModification/NpcModification/WeaponModification/.../Unknown declares
        // its own element type) rather than a scalar. Widening a list/struct column the way a
        // scalar conflict widens would cost the *working* subclass its structured element metadata
        // to make the other subclasses less obviously broken — not a fix. The shape-based rule
        // (MergeSiblingColumn) must leave this column's typed array shape alone.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");

        Assert.Equal("array", properties.ApiType);
        Assert.NotNull(properties.ElementType);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_ExtractsCorrectPropertyAndStepForEverySubclass()
    {
        // #339: keeping the column's shape (test above) isn't enough on its own — until this fix,
        // Extract was still bound to whichever single sibling won schema discovery, so every OTHER
        // sibling's own Properties list read back null (a foreign PropertyInfo throws, the throw is
        // swallowed). All five OMOD subclasses share the exact same generic element classes
        // (ObjectMod{Bool,Enum,Float,FormLinkFloat,FormLinkInt,Int,String}Property<T>) — confirmed
        // against the real Mutagen.Bethesda.Fallout4 source, not assumed from the brief — with T
        // (the per-subclass "which property" enum) the only thing that varies. One element per
        // subclass, all five asserted in one test deliberately (same rationale as the GMST/GLOB
        // tests above): the defect is invisible if only the discovery-winning subclass is checked.
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

        // Merging makes this column dispatch-guarded — a record of a *sixth*, non-OMOD subclass
        // (hypothetically) would read null through it, same as any dispatch-guarded column already
        // does (see WidenedExtract's own column) — AllowsNull must say so, not still claim false.
        Assert.True(properties.AllowsNull);

        AssertFirstElement(properties, armor, "BodyPart", 1f);
        AssertFirstElement(properties, npc, "ForcedInventory", 2f);
        AssertFirstElement(properties, weapon, "AmmoCapacity", 3f);
        // AObjectModification.NoneProperty (Object/Unknown's T) is a genuinely empty enum — 0
        // members — confirmed against the real source (ObjectModification.cs), not assumed. An
        // enum value with no matching member name stringifies to its raw numeric value, "0" here
        // (default(T)), not null.
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
    public void GetSchemas_Omod_PropertiesColumn_PropertySubField_EnumValuesIsUnionOfSiblingEnums()
    {
        // #339 design decision: the `property` sub-field's EnumValues become the union of every
        // sibling's own T enum member names — Armor.Property, Npc.Property, Weapon.Property (and
        // AObjectModification.NoneProperty, which has zero members, contributing nothing). Member
        // names below are transcribed directly from the real Mutagen source (Armor.cs, Npc.cs,
        // Weapon.cs in references/Mutagen/Mutagen.Bethesda.Fallout4/Records/Major Records/), not
        // assumed — a prior ticket's plan (see #339's own issue-comment scope correction on dmgt)
        // shipped wrong precisely by trusting a brief's description of a Mutagen shape instead of
        // reading it.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "properties");
        var propertyField = properties.ElementType!.Fields!.Single(f => f.Name == "property");

        Assert.Contains("BodyPart", propertyField.EnumValues); // Armor.Property-only member
        Assert.Contains("ForcedInventory", propertyField.EnumValues); // Npc.Property-only member
        Assert.Contains("AmmoCapacity", propertyField.EnumValues); // Weapon.Property-only member
        Assert.Contains("Keywords", propertyField.EnumValues); // shared by Armor.Property and Npc.Property — union must not duplicate it
        Assert.Equal(propertyField.EnumValues.Count, propertyField.EnumValues.Distinct().Count());
    }

    // ── #360: OMOD's Properties element never surfaced the property's actual Value ─────────────
    // IAObjectModPropertyGetter<T> (walked above) declares only Property/Step. The real payload —
    // Value, Value2, Record, FunctionType, EnumIntValue — lives on seven separate leaf getter
    // interfaces BuildSubSchema never descended into (IObjectMod{Int,Float,Bool,String,Enum,
    // FormLinkInt,FormLinkFloat}PropertyGetter<T>), confirmed against the real
    // ObjectMod*Property_Generated.cs sources, not assumed. Read-only by design: the write path
    // for this element is #531's own defect (Activator.CreateInstance on the abstract
    // AObjectModProperty<T> already throws for every write today), not this ticket's.

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

        // value/value2/function_type collide in CLR type across the seven leaves (e.g. value is
        // uint on Int, float on Float, bool on Bool, string on String) -> the #263 read-only-text
        // rung. record (FormLink, only FormLinkInt/FormLinkFloat) and enum_int_value (uint, only
        // Enum) don't collide across the leaves that declare them at all -> stay typed.
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

        // Unused (String/Enum leaves' own reserved padding uint32) is deliberately excluded —
        // Mutagen's own name for it, and xEdit's own definition (wbUnused(3)/wbUnused(2) in
        // wbDefinitionsFO4.pas — never rendered as a field at all), both agree it carries no
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
        // #339: DamageType.DamageTypes (ExtendedList<DamageTypeItem>, a struct of two formlinks)
        // and DamageTypeIndexed.DamageTypes (ExtendedList<uint>?, a bare scalar list) are a genuine,
        // irreconcilable shape conflict — confirmed against the real Mutagen source
        // (DamageTypeItem_Generated.cs declares ActorValue/Spell; DamageTypeIndexed_Generated.cs
        // declares neither, nor anything else under that name) — no field names in common at all,
        // unlike OMOD's Properties above. xEdit itself never disambiguates this (wbDefinitionsFO4.pas
        // unions both under one form-version-gated 'Damage Types' field, since the two forms can
        // never coexist there); Mutagen modelling them as two co-existing classes is what forces a
        // label here — 'actor_value_indices' borrows xEdit's own element vocabulary for the scalar
        // shape ('Actor Value Index'), the closest thing to not diverging from xEdit at all
        // (ADR-0034). Naming must be shape-based, not win-order-based — the existing DMGT round-trip
        // test's own comment says which subclass wins schema discovery is a reflection-order
        // artifact that must not be pinned — so this asserts fixed column names and per-column
        // dispatch-guarded reads regardless of which subclass the schema race actually returns.
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
        // The "not present on every sibling" branch of MergeSiblingColumn (GlobalFloat.OutputChar,
        // declared only on IGlobalFloatGetter — GlobalInt/Short/Bool have nothing under this name)
        // is real today, not a hypothetical kept only for a future third subclass — confirmed
        // against Global.xml. Extracting off a real GlobalBool instance (rather than arguing from
        // AllowsNull alone) is what actually discharges the nullability requirement for a
        // sibling-exclusive column.
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
    public void GetSchemas_Npc_EnumColumn_MapsToVarcharWithEnumValues()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("enum", col.ApiType);
        Assert.NotEmpty(col.EnumValues);
        Assert.Contains("Unaggressive", col.EnumValues);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_Apply_SetsEnumValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "aggression");
        Assert.NotNull(col.Apply);
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        col.Apply(npc, System.Text.Json.JsonDocument.Parse("\"Unaggressive\"").RootElement);
        Assert.Equal("Unaggressive", col.Extract(npc)?.ToString());

        // confirm ignoreCase: true
        col.Apply(npc, System.Text.Json.JsonDocument.Parse("\"aggressive\"").RootElement);
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

    /// <summary>
    /// #532: the mechanism-level proof, independent of <c>RecordEditService.ValidateFormLinks</c>
    /// (which already refuses most malformed FormKey strings before <c>ColumnSpec.Apply</c> is ever
    /// reached at the public <c>EditField</c> door — see <c>ScalarFieldApplierRefusalTests</c>'s own
    /// note on this). Calling <c>Apply</c> directly is what actually exercises
    /// <c>SchemaReflector.ApplyFormLinkJson</c>'s own behaviour: a malformed string used to be a
    /// silent no-op reported as <c>ApplyOutcome.Applied</c> (via the pre-#532 unconditional-<c>true</c>
    /// contract) regardless of a caller that reaches this column without going through
    /// <c>ValidateFormLinks</c> first.
    /// </summary>
    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_Apply_MalformedFormKeyString_IsRejected()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "race");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var originalRace = npc.Race.FormKeyNullable;

        var outcome = col.Apply!(npc, System.Text.Json.JsonDocument.Parse("\"not-a-formkey\"").RootElement);

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
        // #429: a top-level FormLink column gets the same ApplyFormLinkJson write delegate its
        // struct/array sub-field sibling already had — no longer a null-Apply read-only column.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "race");
        Assert.NotNull(col);
        Assert.NotNull(col!.Apply);
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

    // ── Phase 12: array and struct field types ─────────────────────────────────

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
        Assert.Equal("aggro_radius", SchemaReflector.ToSnakeCase("AggroRadius"));
    }

    [Fact]
    public void ToSnakeCase_SingleWord_LowercasesOnly()
    {
        Assert.Equal("name", SchemaReflector.ToSnakeCase("Name"));
    }

    [Fact]
    public void ToSnakeCase_MultipleWordBoundaries_AllConverted()
    {
        Assert.Equal("aggro_radius_behavior_enabled", SchemaReflector.ToSnakeCase("AggroRadiusBehaviorEnabled"));
    }

    [Fact]
    public void ToSnakeCase_AlreadyLowercase_Unchanged()
    {
        Assert.Equal("name", SchemaReflector.ToSnakeCase("name"));
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
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            HeightMin = 1.0f
        };

        col.Apply(npc, System.Text.Json.JsonDocument.Parse("2.5").RootElement);

        Assert.Equal(2.5f, npc.HeightMin, precision: 3);
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
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var kw1 = Mutagen.Bethesda.Plugins.FormKey.Factory("000010:Fallout4.esm");
        var kw2 = Mutagen.Bethesda.Plugins.FormKey.Factory("000020:Fallout4.esm");

        var json = $"[\"{kw1}\",\"{kw2}\"]";
        // #503: an array-shaped payload is written, and says so — the other side of the shape guard.
        Assert.Equal(ApplyOutcome.Applied, col.Apply(npc, System.Text.Json.JsonDocument.Parse(json).RootElement));

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
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var factionKey = Mutagen.Bethesda.Plugins.FormKey.Factory("000003:Fallout4.esm");
        var json = $"[{{\"faction\":\"{factionKey}\",\"rank\":7}}]";

        col.Apply(npc, System.Text.Json.JsonDocument.Parse(json).RootElement);

        Assert.Single(npc.Factions);
        Assert.Equal(7, npc.Factions[0].Rank);
        Assert.Equal(factionKey, npc.Factions[0].Faction.FormKey);
    }

    // ── IsFormLink requires both IsInterface AND IsGenericType (mutant 599) ─────

    [Fact]
    public void GetSchemas_Npc_Factions_Apply_NonArrayJson_DoesNothing()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "factions");
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        // #503: "does nothing" is only half of it — the applier has to *say* it wrote nothing, or the
        // write path reports the edit as applied and the user's change vanishes silently.
        var applied = col.Apply!(npc, System.Text.Json.JsonDocument.Parse("\"notanarray\"").RootElement);

        Assert.Equal(ApplyOutcome.ValueRejected, applied);
        Assert.Empty(npc.Factions);
    }

    [Fact]
    public void GetSchemas_Npc_Weight_IsStructNotFormkey()
    {
        // INpcWeightGetter is a non-generic interface. With the IsFormLink && → || mutant,
        // IsInterface=true alone would classify it as a formkey column.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
    }

    // ── Null list returns null from Extract (mutant 894) ──────────────────────

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
        // the sub-field Apply delegates (loqui scalar Apply path, lines ~582-597).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "weight");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        var json = """{"thin":0.5,"fat":0.8,"muscular":0.3}""";
        // #503: an object-shaped payload is written, and says so — the other side of the shape guard.
        Assert.Equal(ApplyOutcome.Applied, col.Apply(npc, System.Text.Json.JsonDocument.Parse(json).RootElement));

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

        // #503, struct half of the same rule: a non-object payload is reported as not written.
        var applied = col.Apply!(npc, System.Text.Json.JsonDocument.Parse("[1,2,3]").RootElement);

        Assert.Equal(ApplyOutcome.ValueRejected, applied);
        Assert.Equal(originalWeight, npc.Weight);
    }

    [Fact]
    public void GetSchemas_Npc_Weight_Apply_PreservesExistingSubFieldValues()
    {
        // Kills the :594 survived mutants (operand-swap and remove-left).
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

        col.Apply!(npc, System.Text.Json.JsonDocument.Parse("{\"thin\":0.5}").RootElement);

        Assert.NotNull(npc.Weight);
        Assert.Equal(0.5f, npc.Weight!.Thin, precision: 3);
        Assert.Equal(0.1f, npc.Weight.Fat, precision: 3);
        Assert.Equal(0.2f, npc.Weight.Muscular, precision: 3);
    }

    // ── ulong column: TryMapPrimitive BIGINT path (mutant 296/297) ───────────────

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
    // For each primitive api-type, verify that a top-level column of that type exists (GetColumnInfo
    // handled it) AND a sub-field of that same type exists in a struct/array-element column
    // (GetSubFieldInfo handled it).  A refactor that drops a type from one chain but not the other
    // will fail the sub-field assertion.
    //
    // float: height_min (top) / npc_ weight.thin (sub)
    // int:   xp_value_offset (top) / npc_ factions[].rank (sub, sbyte -> int)
    // formKey: race (top) / npc_ factions[].faction (sub)
    // enum:  aggression (top) / npc_ face_tinting_layers[].data_type (sub)
    // bool:  aggro_radius_behavior_enabled (top) — no bool sub-field found in npc_ structs; bool
    //        parity is asserted by confirming the DuckDbType for the top-level column.

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

    // ── Phase 12.1: bitmask / [Flags] enum support ────────────────────────────

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
    public void GetSchemas_Npc_FlagColumn_HasEnumBitValues()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "flags");
        Assert.NotNull(col);
        Assert.NotNull(col!.EnumBitValues);
        Assert.Equal(col.EnumValues.Count, col.EnumBitValues!.Count);
        Assert.All(col.EnumBitValues, s =>
        {
            long v = long.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
            Assert.True(v > 0 && (v & (v - 1)) == 0);
        });
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_EnumBitValuesIsNull()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "aggression");
        Assert.NotNull(col);
        Assert.Null(col!.EnumBitValues);
    }

    [Fact]
    public void GetSchemas_FlagColumn_EnumBitValues_ContainsOnlyPowerOfTwo()
    {
        // GetEnumMeta must filter out None=0 and composite values — only atomic power-of-two
        // bits should appear. The Npc.Flag enum has only clean power-of-two values, so this
        // test guards against regressions that re-introduce 0 or composite entries.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "flags");
        Assert.NotNull(col);
        Assert.NotNull(col!.EnumBitValues);
        Assert.DoesNotContain("0", col.EnumBitValues!);
        Assert.All(col.EnumBitValues, s =>
        {
            long v = long.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
            Assert.True(v > 0 && (v & (v - 1)) == 0, $"Expected a power-of-two bit value, got {s}");
        });
    }

    [Fact]
    public void GetSchemas_Race_FlagColumn_HighBitEnumBitValues_SerializedAsStrings()
    {
        // Race.Flag is ulong-backed with LowPriorityPushable = 2^53 and
        // CannotUsePlayableItems = 2^54 — both beyond JS Number MAX_SAFE_INTEGER.
        // EnumBitValues must be string so the frontend can parse them as BigInt.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["race"].RecordColumns.Single(c => c.Name == "flags");
        Assert.NotNull(col.EnumBitValues);
        Assert.Contains("9007199254740992", col.EnumBitValues!);   // LowPriorityPushable = 2^53
        Assert.Contains("18014398509481984", col.EnumBitValues!);  // CannotUsePlayableItems = 2^54
        Assert.Contains("1", col.EnumBitValues!);                   // Playable (low-bit sanity check)
    }

    [Fact]
    public void GetSchemas_Race_FlagColumn_Apply_AcceptsHighBitDecimalString()
    {
        // Bitmask edits arrive from the frontend as decimal strings so values above 2^53
        // survive JSON. Apply must parse the string token, not throw on it (GetInt64 would).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["race"].RecordColumns.Single(c => c.Name == "flags");
        Assert.NotNull(col.Apply);

        var race = new Mutagen.Bethesda.Fallout4.Race(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        col.Apply!(race, System.Text.Json.JsonDocument.Parse("\"9007199254740993\"").RootElement);

        Assert.Equal(9007199254740993UL, (ulong)race.Flags);
    }

    [Fact]
    public void GetSchemas_Npc_FlagColumn_Apply_AcceptsNumberToken()
    {
        // Legacy numeric tokens (values below 2^53) must still apply.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.Single(c => c.Name == "flags");
        Assert.NotNull(col.Apply);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var bit = long.Parse(col.EnumBitValues![0], System.Globalization.CultureInfo.InvariantCulture);

        col.Apply!(npc, System.Text.Json.JsonDocument.Parse(bit.ToString(System.Globalization.CultureInfo.InvariantCulture)).RootElement);

        Assert.Equal((ulong)bit, (ulong)npc.Flags);
    }

    [Fact]
    public void GetSchemas_Misc_CompositeFlagsEnum_IsNotBitmask()
    {
        // MiscItem.MajorFlag has [Flags] but CalcFromComponents=11 and PackInUseOnly=13 —
        // both non-power-of-two. GetEnumMeta must fall back to plain-enum treatment.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("misc"), "misc schema must be present");
        var col = schemas["misc"].RecordColumns.FirstOrDefault(c => c.Name == "major_flags");
        Assert.NotNull(col);
        Assert.False(col!.IsBitmask);
        Assert.Null(col.EnumBitValues);
    }

    // ── Issue #1 slice A1: plugin header as a first-class record ─────────────
    // ModHeader isn't a major record in Mutagen (no FormKey/EditorID), so it can't be
    // discovered by the major-record-getter scan — it gets one hand-assembled schema
    // entry instead, built via a second small reflection pass.

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
        // Issue #118: header flags display xEdit's vocabulary, not raw Mutagen member names.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "flags");
        Assert.NotNull(col);
        Assert.Equal("BIGINT", col!.DuckDbType);
        Assert.Equal("enum", col.ApiType);
        Assert.True(col.IsBitmask);
        Assert.Contains("ESM", col.EnumValues);
        Assert.DoesNotContain("Master", col.EnumValues);
        Assert.Contains("ESL", col.EnumValues);
        Assert.DoesNotContain("Small", col.EnumValues);
        Assert.Contains("Localized", col.EnumValues);
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
        // Issue #118: only Mutagen.Bethesda.Fallout4 is referenced by this project, so a live
        // second-game schema (e.g. Starfield's "Light" member) isn't reflectable here — this
        // exercises the mapping directly against every Mutagen member name it must key off of,
        // proving the mapping is keyed by name, not by bit position, and includes a non-Fallout
        // member name ("LightMaster") per the acceptance criteria.
        Assert.Equal(expected, SchemaReflector.MapToXEditFlagName(mutagenName));
    }

    [Fact]
    public void GetSchemas_Header_FlagsColumn_EnumValuesStayPositionallyAlignedWithBitValues()
    {
        // Renaming for xEdit display must not disturb the parallel EnumValues/EnumBitValues
        // arrays that consumers index in lockstep.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "flags");
        Assert.NotNull(col);
        Assert.NotNull(col!.EnumBitValues);
        Assert.Equal(col.EnumValues.Count, col.EnumBitValues!.Count);

        var esmIndex = col.EnumValues.ToList().IndexOf("ESM");
        Assert.Equal("1", col.EnumBitValues[esmIndex]);

        var eslIndex = col.EnumValues.ToList().IndexOf("ESL");
        Assert.Equal(((long)Mutagen.Bethesda.Fallout4.Fallout4ModHeader.HeaderFlag.Small).ToString(
            System.Globalization.CultureInfo.InvariantCulture), col.EnumBitValues[eslIndex]);
    }

    [Fact]
    public void GetSchemas_Header_EslFlagValue_UnaffectedByDisplayNameRename()
    {
        // EslFlagValue detection runs off the original Mutagen member name (LightMasterFlagNames),
        // computed before the xEdit display-name rename is applied to EnumValues.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.Equal((long)Mutagen.Bethesda.Fallout4.Fallout4ModHeader.HeaderFlag.Small,
            schemas["header"].EslFlagValue);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnApply_FlagsStagesSameBitmaskValueAfterRename()
    {
        // Toggling a renamed flag (e.g. "ESM") must produce the same bitmask value it always has —
        // this is a labelling change only, not a protocol change.
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        var flagsIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "flags");
        var mod = new Mutagen.Bethesda.Fallout4.Fallout4Mod(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("Test.esp"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        var bitmask = (long)Mutagen.Bethesda.Fallout4.Fallout4ModHeader.HeaderFlag.Master;
        var json = System.Text.Json.JsonDocument.Parse(
            $"\"{bitmask.ToString(System.Globalization.CultureInfo.InvariantCulture)}\"").RootElement;

        schema.HeaderColumnApply![flagsIndex]!(mod, json);

        Assert.Equal(Mutagen.Bethesda.Fallout4.Fallout4ModHeader.HeaderFlag.Master, mod.ModHeader.Flags);
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
        // what ArrayRowGroup on the frontend keys off to render masters as a repeatable list.
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
    public void GetSchemas_Header_HeaderColumnApply_HasOneEntryPerColumnInOrder()
    {
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        Assert.NotNull(schema.HeaderColumnApply);
        Assert.Equal(schema.RecordColumns.Count, schema.HeaderColumnApply!.Count);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnApply_AuthorFlagsAndMastersWritable()
    {
        // Issue #86: masters becomes a writable (add-only) header column.
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        int Index(string name) => schema.RecordColumns.ToList().FindIndex(c => c.Name == name);

        Assert.NotNull(schema.HeaderColumnApply![Index("author")]);
        Assert.NotNull(schema.HeaderColumnApply![Index("flags")]);
        Assert.NotNull(schema.HeaderColumnApply![Index("masters")]);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnApply_MastersWritesModMasterReferences()
    {
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        var mastersIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "masters");

        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);

        schema.HeaderColumnApply![mastersIndex]!(mod, JsonSerializer.SerializeToElement(new[] { "Fallout4.esm", "DLCRobot.esm" }));

        Assert.Equal(
            ["Fallout4.esm", "DLCRobot.esm"],
            ((Mutagen.Bethesda.Plugins.Records.IMod)mod).MasterReferences.Select(r => r.Master.FileName.ToString()));
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnApply_AuthorWritesModHeaderAuthor()
    {
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        var authorIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "author");

        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var json = System.Text.Json.JsonSerializer.SerializeToElement("New Author");
        schema.HeaderColumnApply![authorIndex]!(mod, json);

        Assert.Equal("New Author", mod.ModHeader.Author);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnApply_AuthorJsonNull_ClearsModHeaderAuthor()
    {
        // #365 mutation-triage gap: MakeApplier's JSON-null-write branch (`if (nullable)
        // rp.SetValue(obj, null); return;`) was never exercised by any test — every existing Apply
        // test only ever writes a real value. Author is nullable (HeaderPropertyApply's own
        // nullable: true), so clearing it via JSON null is a real, user-visible requirement (the
        // record editor clearing an optional field), not just a mutation-kill exercise.
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        var authorIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "author");

        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Some Author";

        var nullJson = System.Text.Json.JsonSerializer.SerializeToElement<string?>(null);
        schema.HeaderColumnApply![authorIndex]!(mod, nullJson);

        Assert.Null(mod.ModHeader.Author);
    }

    [Fact]
    public void GetSchemas_Header_HeaderColumnApply_FlagsWritesModHeaderFlags()
    {
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        var flagsIndex = schema.RecordColumns.ToList().FindIndex(c => c.Name == "flags");

        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var bitmask = (long)Fallout4ModHeader.HeaderFlag.Small;
        var json = System.Text.Json.JsonSerializer.SerializeToElement(
            bitmask.ToString(System.Globalization.CultureInfo.InvariantCulture));
        schema.HeaderColumnApply![flagsIndex]!(mod, json);

        Assert.Equal(Fallout4ModHeader.HeaderFlag.Small, mod.ModHeader.Flags);
    }

    [Fact]
    public void GetSchemas_Header_EslFlagValue_IsTheSmallBit()
    {
        var schema = _reflector.GetSchemas(GameRelease.Fallout4)["header"];
        Assert.Equal((long)Fallout4ModHeader.HeaderFlag.Small, schema.EslFlagValue);
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

    // ── Issue #178: condition-list properties must not double as generic array columns ──
    // Perk.Conditions is condition-shaped (IReadOnlyList<IConditionGetter>) and is already
    // surfaced by Fallout4ConditionCodec.Extract into the dedicated Conditions section;
    // reflecting it again here as a plain array column duplicates it in the record editor.
    // Perk.Effects (IReadOnlyList<IAPerkEffectGetter>) is an ordinary list-of-struct with no
    // condition shape and must keep its normal array column — paired here so the fix can't be
    // a blanket "skip all list-of-struct properties" overreach.

    [Fact]
    public void GetSchemas_Perk_ConditionsProperty_ExcludedFromGenericColumns()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["perk"].RecordColumns;
        Assert.DoesNotContain(columns, c => c.Name == "conditions");
    }

    [Fact]
    public void GetSchemas_Perk_EffectsProperty_StillGetsGenericArrayColumn()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["perk"].RecordColumns;
        Assert.Contains(columns, c => c.Name == "effects" && c.ApiType == "array");
    }
}
