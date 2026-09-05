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
        Assert.False(schemas.ContainsKey("Land"));
        Assert.False(schemas.ContainsKey("navm"));
        Assert.False(schemas.ContainsKey("navi"));
    }

    // ── the virtual-machine adapter is an ordinary reflected column ───────────

    [Fact]
    public void GetSchemas_Npc_VirtualMachineAdapter_IsAReflectedStructColumn()
    {
        var columns = _reflector.GetSchemas(GameRelease.Fallout4)["npc_"].RecordColumns;

        var adapter = Assert.Single(columns, c => c.Name == "VirtualMachineAdapter");
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

        Assert.DoesNotContain(columns, c => c.Name == "VirtualMachineAdapter");
        Assert.Contains(columns, c => c.Name == "AutoCalcValue");
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

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_KeepsStructuredArrayShape_NotWidened()
    {
        // OMOD's Properties is the same per-subclass-typed shape as GMST/GLOB's Data, but on a list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "Properties");

        Assert.Equal("array", properties.ApiType);
        Assert.NotNull(properties.ElementType);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_PropertySubField_EnumMembersAreUnionOfSiblingEnums()
    {
        // The `property` sub-field's members are the union of every sibling's own T enum member
        // names.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "Properties");
        var propertyField = properties.ElementType!.Fields!.Single(f => f.Name == "Property");

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
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "Properties");
        var fields = properties.ElementType!.Fields!;

        var value = fields.Single(f => f.Name == "Value");
        var value2 = fields.Single(f => f.Name == "Value2");
        var record = fields.Single(f => f.Name == "Record");
        var functionType = fields.Single(f => f.Name == "FunctionType");
        var enumIntValue = fields.Single(f => f.Name == "EnumIntValue");

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
        Assert.DoesNotContain(fields, f => f.Name == "Unused");
    }


    [Fact]
    public void GetSchemas_Glob_OutputCharColumn_ExclusiveToGlobalFloat_NullOnOtherSubclasses()
    {
        // The "not present on every sibling" branch of MergeSiblingColumn is real today, not a
        // hypothetical kept for a future third subclass: the column belongs to GlobalFloat alone, so
        // it writes onto one and declines a GlobalBool by name.
        var mod = new Fallout4Mod(ModKey.FromFileName("GlobOutputChar263.esp"), Fallout4Release.Fallout4);
        var f = new GlobalFloat(mod.GetNextFormKey("TestGlobFloat"), Fallout4Release.Fallout4) { EditorID = "TestGlobFloat", Data = 1.25f, OutputChar = true };
        var b = new GlobalBool(mod.GetNextFormKey("TestGlobBool"), Fallout4Release.Fallout4) { EditorID = "TestGlobBool", Data = true };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var outputChar = schemas["glob"].RecordColumns.Single(c => c.Name == "OutputChar");

        Assert.True(outputChar.AllowsNull);
        Assert.Null(outputChar.Variants);
        Assert.Equal(ApplyOutcome.Applied, outputChar.Apply.Writer!(f, JsonDocument.Parse("false").RootElement));
        Assert.False(f.OutputChar);
        Assert.Equal(ApplyOutcome.PropertyNotFound, outputChar.Apply.Writer!(b, JsonDocument.Parse("false").RootElement));
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
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "AggroRadiusBehaviorEnabled");
        Assert.NotNull(col);
        Assert.Equal("BOOLEAN", col.DuckDbType);
        Assert.Equal("bool", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_MapsToVarcharWithEnumMembers()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Aggression");
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
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "Aggression");
        Assert.NotNull(col.Apply.Writer);
        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("\"Unaggressive\"").RootElement);
        Assert.Equal(Npc.AggressionType.Unaggressive, npc.Aggression);

        // confirm ignoreCase: true
        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("\"aggressive\"").RootElement);
        Assert.Equal(Npc.AggressionType.Aggressive, npc.Aggression);
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_MapsToFormKeyTypeWithValidTypes()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Race");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("formKey", col.ApiType);
        Assert.Contains("Race", col.ValidFormKeyTypes);
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_Apply_MalformedFormKeyString_IsRejected()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "Race");
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
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Race");
        Assert.NotNull(col);
        Assert.False(col!.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Voice_IsNullableFormLink()
    {
        // Voice is IFormLinkNullable<IVoiceTypeGetter> — AllowsNull must be true.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Voice");
        Assert.NotNull(col);
        Assert.True(col!.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Faction_SubField_IsNonNullableFormLink()
    {
        // RankPlacement.Faction is IFormLink<IFactionGetter> — non-nullable sub-field.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Factions");
        Assert.NotNull(col);
        var faction = col!.ElementType?.Fields?.FirstOrDefault(f => f.Name == "Faction");
        Assert.NotNull(faction);
        Assert.False(faction!.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_HasApply()
    {
        // A top-level FormLink column carries the same ApplyFormLinkJson write delegate as its
        // struct/array sub-field sibling — not a null-Apply read-only column.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Race");
        Assert.NotNull(col);
        // The delegate, not the LeafWrite wrapper: asserting the wrapper is unconditionally true now that
        // Apply is non-nullable, which would leave this fact proving nothing at all.
        Assert.NotNull(col!.Apply.Writer);
    }

    [Fact]
    public void GetSchemas_Npc_TranslatedStringColumn_IsATranslatedStringLeaf()
    {
        // EditorID is excluded from RecordColumns (it's a base column), but Name is a translated string.
        // BleedoutOverride is a short/int type. Find a string or translated-string column on NPC.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        // The NPC Name is a TranslatedString, which the codec spells as an object.
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Name");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("translatedString", col.ApiType);
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
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Keywords");
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
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Keywords");
        Assert.NotNull(col);
        Assert.NotNull(col.ElementType);
        Assert.True(col.ElementType.IsSortable);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_IsReflectedAsArrayOfStructs()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Factions");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.ElementType);
        Assert.Equal("struct", col.ElementType.Type);
        var fields = col.ElementType.Fields;
        Assert.NotNull(fields);
        Assert.Contains(fields, f => f.Name == "Faction" && f.Type == "formKey");
        Assert.Contains(fields, f => f.Name == "Rank" && f.Type == "int");
    }

    // ── Float column ──────────────────────────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_FloatColumn_HasFloatDuckDbAndApiType()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "HeightMin");
        Assert.NotNull(col);
        Assert.Equal("FLOAT", col.DuckDbType);
        Assert.Equal("float", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_FloatColumn_Apply_ChangesValue()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "HeightMin");
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
        var nullableCol = schemas["npc_"].RecordColumns.First(c => c.Name == "FacialMorphIntensity");
        Assert.NotNull(nullableCol.Apply.Writer); // the delegate, not the always-present wrapper
        npc.FacialMorphIntensity = 1.0f;

        nullableCol.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse("null").RootElement);

        Assert.Null(npc.FacialMorphIntensity);
    }

    // ── Array Apply ───────────────────────────────────────────────────────────

    [Fact]
    public void GetSchemas_Npc_Keywords_Apply_ReplacesKeywordList()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Keywords");
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
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Factions");
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
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "Factions");
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
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Weight");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
    }

    // ── Loqui scalar Apply: applies JSON object to struct sub-field ───────────────

    [Fact]
    public void GetSchemas_Npc_Weight_Apply_UpdatesSubFields()
    {
        // The weight column holds INpcWeightGetter (a Loqui scalar). Apply should
        // deserialise a JSON object and write each primitive sub-field back via
        // the sub-field Apply delegates (the Loqui scalar Apply path).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Weight");
        Assert.NotNull(col);
        Assert.NotNull(col.Apply.Writer);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);

        var json = """{"Thin":0.5,"Fat":0.8,"Muscular":0.3}""";
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
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "Weight");
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
        var col = schemas["npc_"].RecordColumns.First(c => c.Name == "Weight");
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
        var col = schemas["imad"].RecordColumns.FirstOrDefault(c => c.Name == "Unknown");
        Assert.NotNull(col);
        Assert.Equal("BIGINT", col.DuckDbType);
        Assert.Equal("int", col.ApiType);
    }

    // ── Primitive type parity: GetColumnInfo and GetSubFieldInfo cover the same types ──
    //
    // A refactor dropping a type from one chain but not the other fails the sub-field assertion.

    [Theory]
    [InlineData("HeightMin", "float", "FLOAT", "Weight", false, "Thin")]
    [InlineData("XpValueOffset", "int", "INTEGER", "Factions", true, "Rank")]
    [InlineData("Race", "formKey", "VARCHAR", "Factions", true, "Faction")]
    [InlineData("Aggression", "enum", "VARCHAR", "FaceTintingLayers", true, "DataType")]
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

    // ── Bitmask / [Flags] enum support ────────────────────────────

    [Fact]
    public void GetSchemas_Npc_FlagColumn_IsAFlagsLeaf_TheCodecSpellsAsNames()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Flags");
        Assert.NotNull(col);
        Assert.Equal("Flags", col!.ApiType);
        Assert.Equal("VARCHAR", col.DuckDbType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_IsAPlainEnum()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Aggression");
        Assert.NotNull(col);
        Assert.Equal("enum", col!.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_MembersCarryNoBit()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Aggression");
        Assert.NotNull(col);
        Assert.All(col!.EnumMembers, m => Assert.Null(m.BitValue));
    }

    [Fact]
    public void GetSchemas_FlagColumn_EveryMemberCarriesAnAtomicBit()
    {
        // GetEnumMembers must filter out None=0 and composite values — only atomic power-of-two bits
        // should appear.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Flags");
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
        var col = schemas["Race"].RecordColumns.Single(c => c.Name == "Flags");
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
        var col = schemas["Race"].RecordColumns.Single(c => c.Name == "Flags");
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
        var col = schemas["npc_"].RecordColumns.Single(c => c.Name == "Flags");
        Assert.NotNull(col.Apply.Writer);

        var npc = new Mutagen.Bethesda.Fallout4.Npc(
            Mutagen.Bethesda.Plugins.FormKey.Factory("000001:Fallout4.esm"),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        var bit = long.Parse(col.EnumMembers[0].BitValue!, System.Globalization.CultureInfo.InvariantCulture);

        col.Apply.Writer!(npc, System.Text.Json.JsonDocument.Parse(bit.ToString(System.Globalization.CultureInfo.InvariantCulture)).RootElement);

        Assert.Equal((ulong)bit, (ulong)npc.Flags);
    }

    [Fact]
    public void GetSchemas_Misc_CompositeFlagsEnum_IsStillAFlagsLeaf_WithNoBitPerMember()
    {
        // MiscItem.MajorFlag has [Flags] but CalcFromComponents=11 and PackInUseOnly=13 —
        // both non-power-of-two: the codec still writes it as a name array, and GetEnumMembers
        // keeps every member with no bit.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("misc"), "misc schema must be present");
        var col = schemas["misc"].RecordColumns.FirstOrDefault(c => c.Name == "MajorFlags");
        Assert.NotNull(col);
        Assert.Equal("Flags", col!.ApiType);
        Assert.All(col.EnumMembers, m => Assert.Null(m.BitValue));
    }

    // ── Plugin header as a first-class record ─────────────────────────────────
    // ModHeader is not a major record in Mutagen (no FormKey or EditorID), so it cannot be discovered
    // by the major-record-getter scan and gets one hand-assembled schema entry instead.

    [Fact]
    public void GetSchemas_ContainsHeaderTable()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("Header"));
    }

    [Fact]
    public void GetSchemas_Header_AuthorColumn_IsStringType()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["Header"].RecordColumns.FirstOrDefault(c => c.Name == "Author");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col!.DuckDbType);
        Assert.Equal("string", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Header_FlagsColumn_CarriesMutagensNamesLabelledWithXEdits()
    {
        // The document spells the header's flags by Mutagen's member names; xEdit's vocabulary is
        // the label, never the value (presentation never rewrites a value).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["Header"].RecordColumns.FirstOrDefault(c => c.Name == "Flags");
        Assert.NotNull(col);
        Assert.Equal("Flags", col!.ApiType);
        Assert.Equal("ESM", col.EnumMembers.Single(m => m.Value == "Master").Label);
        Assert.Equal("ESL", col.EnumMembers.Single(m => m.Value == "Small").Label);
        Assert.Null(col.EnumMembers.Single(m => m.Value == "Localized").Label);
        Assert.DoesNotContain(col.EnumMembers, m => m.Value is "ESM" or "ESL");
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
    public void GetSchemas_Header_MastersColumn_IsTheDocumentsOwnMasterReferences()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["Header"].RecordColumns.FirstOrDefault(c => c.Name == "MasterReferences");
        Assert.NotNull(col);
        Assert.Equal("array", col!.ApiType);
        Assert.Equal("ModHeader.MasterReferences", col.PropertyName);
        Assert.NotNull(col.ElementType);
        Assert.Equal("struct", col.ElementType!.Type);
        Assert.Contains(col.ElementType.Fields!, f => f.Name == "Master" && f.Type == "string");
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_ToFieldMetadata_IsArrayTrue()
    {
        // The column itself must be flagged as an array (not just ApiType == "array") — this is
        // what the frontend's array rows key off to render masters as a repeatable list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["Header"].RecordColumns.Single(c => c.Name == "MasterReferences");
        Assert.True(col.ToFieldMetadata().IsArray);
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_ElementType_IsNotItselfAnArray()
    {
        // Each master is a single plugin-filename string, not a nested array — the element
        // FieldMetadata's own IsArray must be false, or the frontend would try to render each
        // master entry as a further repeatable list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["Header"].RecordColumns.Single(c => c.Name == "MasterReferences");
        Assert.NotNull(col.ElementType);
        Assert.False(col.ElementType!.IsArray);
    }

    [Fact]
    public void GetSchemas_Header_RecordType_IsHeaderGetterInterface_NotAMajorRecordType()
    {
        // Guards against the header schema ever being routed through the major-record
        // indexing loop (EnumerateMajorRecords), which assumes an IMajorRecordGetter.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["Header"];
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
        var columns = schemas["Perk"].RecordColumns;
        Assert.Contains(columns, c => c.Name == "Conditions" && c.ApiType == "array");
    }

    [Fact]
    public void GetSchemas_Perk_EffectsProperty_StillGetsGenericArrayColumn()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["Perk"].RecordColumns;
        Assert.Contains(columns, c => c.Name == "Effects" && c.ApiType == "array");
    }

    // ── P3Int16/P3Float leaf coverage ──────────────────────────────────────────

    [Fact]
    public void GetSchemas_Container_HasObjectBoundsColumn_WithFirstSecondVectorSubFields()
    {
        // ObjectBounds.First/Second are Noggog.P3Int16, which the codec spells as "x, y, z" text: a
        // vector leaf each, so the column keeps both rather than dropping them as unclassified.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.FirstOrDefault(c => c.Name == "ObjectBounds");
        Assert.NotNull(col);
        Assert.Equal("struct", col!.ApiType);

        Assert.Equal("vector", col.SubFields?.FirstOrDefault(f => f.Name == "First")?.Type);
        Assert.Equal("vector", col.SubFields?.FirstOrDefault(f => f.Name == "Second")?.Type);
    }

    [Fact]
    public void GetSchemas_Container_ObjectBounds_Apply_WritesFirstSecondXyz()
    {
        // The rival this defeats: a vector sub-field built with a null Apply makes ApplySubFields
        // silently skip First/Second, so the whole ObjectBounds Apply still reports Applied
        // while ObjectBounds never changed.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "ObjectBounds");
        var container = new Container(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var json = """{"First":"1, 2, 3","Second":"4, 5, 6"}""";
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
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "ObjectBounds");
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
        // Destructible's own sub-schema — "Data" (Destructible's other, already-mappable member)
        // stays present regardless, which is why this can't just check the column exists.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var destructible = schemas["cont"].RecordColumns.First(c => c.Name == "Destructible");

        var resistances = destructible.SubFields?.FirstOrDefault(f => f.Name == "Resistances");
        Assert.NotNull(resistances);
        Assert.Equal("array", resistances!.Type);
        Assert.True(resistances.IsArray);

        var stages = destructible.SubFields?.FirstOrDefault(f => f.Name == "Stages");
        Assert.NotNull(stages);
        Assert.Equal("array", stages!.Type);
        Assert.True(stages.IsArray);
        Assert.Contains(stages.ElementType!.Fields!, f => f.Name == "HealthPercent");
    }

    [Fact]
    public void GetSchemas_Container_Destructible_Apply_WritesStagesArray()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.First(c => c.Name == "Destructible");
        var container = new Container(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var json = """{"Stages":[{"HealthPercent":50}]}""";
        var outcome = col.Apply.Writer!(container, JsonDocument.Parse(json).RootElement);

        Assert.Equal(ApplyOutcome.Applied, outcome);
        Assert.NotNull(container.Destructible);
        Assert.Single(container.Destructible!.Stages);
        Assert.Equal(50, container.Destructible.Stages[0].HealthPercent);
    }

    // ── P3Float, both dispatch paths, on fixtures with no side-table mirror ────────────────────

    [Fact]
    public void GetSchemas_MaterialObject_HasProjectionVectorColumn_AsAVectorLeaf()
    {
        // MaterialObject.ProjectionVector is a direct top-level P3Float column (GetColumnInfo path)
        // with no side-table mirror — unlike Placed*.Position (see the RecordEditService companion
        // refusal), safe to make writable unconditionally.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["mato"].RecordColumns.FirstOrDefault(c => c.Name == "ProjectionVector");
        Assert.NotNull(col);
        Assert.Equal("vector", col!.ApiType);
        Assert.Null(col.SubFields);
    }

    [Fact]
    public void GetSchemas_MaterialObject_ProjectionVector_Apply_WritesXyz()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["mato"].RecordColumns.First(c => c.Name == "ProjectionVector");
        var mato = new MaterialObject(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);

        var outcome = col.Apply.Writer!(mato, JsonDocument.Parse("\"1.5, 2.5, 3.5\"").RootElement);

        Assert.Equal(ApplyOutcome.Applied, outcome);
        Assert.Equal(1.5f, mato.ProjectionVector.X, precision: 3);
        Assert.Equal(2.5f, mato.ProjectionVector.Y, precision: 3);
        Assert.Equal(3.5f, mato.ProjectionVector.Z, precision: 3);
    }

    [Fact]
    public void GetSchemas_PlacedObject_TeleportDestination_HasPositionRotationVectorSubFields()
    {
        // PlacedObject.TeleportDestination.Position/Rotation — P3Float nested one level inside a
        // struct (GetSubFieldInfo path), never mirrored anywhere else, so safe unconditionally too.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var teleport = schemas["refr"].RecordColumns.FirstOrDefault(c => c.Name == "TeleportDestination");
        Assert.NotNull(teleport);

        Assert.Equal("vector", teleport!.SubFields?.FirstOrDefault(f => f.Name == "Position")?.Type);
        Assert.Equal("vector", teleport.SubFields?.FirstOrDefault(f => f.Name == "Rotation")?.Type);
    }

    // ── Noggog's small value-vector struct family, beyond P3Int16/P3Float ──────────────────────

    [Fact]
    public void GetSchemas_Cell_HasGridColumn_WithFlagsAndPointSubFields()
    {
        // Cell.Grid.Point is a Noggog.P2Int, which a ClassifyLeaf limited to P3Int16/P3Float maps
        // not at all.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["Cell"].RecordColumns.FirstOrDefault(c => c.Name == "Grid");
        Assert.NotNull(col);
        Assert.Equal("struct", col!.ApiType);
        Assert.Equal(2, col.SubFields!.Count);

        Assert.Contains(col.SubFields!, f => f.Name == "Flags" && f.Type is "enum" or "Flags");
        Assert.Contains(col.SubFields!, f => f.Name == "Point" && f.Type == "vector");
    }

    [Fact]
    public void GetSchemas_Location_WorldspaceCellsAdded_ElementHasCoordinatesListOfVectors()
    {
        // LocationCoordinate.Coordinates is a list nested inside a struct that is itself a list
        // element, composing the struct-nested-list arm with the widened vector-struct set.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["lctn"].RecordColumns.FirstOrDefault(c => c.Name == "WorldspaceCellsAdded");
        Assert.NotNull(col);
        Assert.Equal("array", col!.ApiType);

        var coordinates = col.ElementType?.Fields?.FirstOrDefault(f => f.Name == "Coordinates");
        Assert.NotNull(coordinates);
        Assert.True(coordinates!.IsArray);
        Assert.Equal("vector", coordinates.ElementType!.Type);
    }

}
