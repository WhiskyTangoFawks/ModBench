using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Indexing;

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
        // ADR-0011: placed objects are indexed as normal records so the worldspace tree,
        // record editor, and agent queries are uniform DuckDB reads.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.ContainsKey("refr"));
        Assert.True(schemas.ContainsKey("achr"));
    }

    [Fact]
    public void GetSchemas_BuildsNoTableForAnExcludedSignature()
    {
        // Landscape and navmesh live in cell children too but aren't standard refs; the REFR-flavour
        // placement variants collapse into refr. Both groups are SchemaAnnotations.ExcludedSignatures.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.False(schemas.ContainsKey("land"));
        Assert.False(schemas.ContainsKey("navm"));
        Assert.False(schemas.ContainsKey("navi"));
        Assert.False(schemas.ContainsKey("pgre"));
        Assert.False(schemas.ContainsKey("phzd"));
    }

    // ── the virtual-machine adapter is an ordinary reflected column ───────────

    [Fact]
    public void GetSchemas_Npc_VirtualMachineAdapter_IsAReflectedStructColumn()
    {
        var columns = _reflector.GetSchemas(GameRelease.Fallout4)["npc_"].RecordColumns;

        var adapter = Assert.Single(columns, c => c.Name == "VirtualMachineAdapter");
        Assert.Equal("struct", adapter.ApiType);
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
        Assert.NotNull(properties.Field.ElementSpec);
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_CarriesEachRecordClassOwnPropertyDomain()
    {
        // Each record class's Properties element closes over its own T, so the column carries a
        // variant per class, each Property sub-field its own enum domain.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "Properties");

        static List<string> PropertyDomain(SubFieldSpec variant)
        {
            var elementSpec = variant.ElementSpec
                ?? throw new InvalidOperationException("Expected a variant to declare an element spec.");
            var subFields = elementSpec.SubFields
                ?? throw new InvalidOperationException("Expected a variant's element spec to declare sub-fields.");
            return [.. subFields.Single(f => f.Name == "Property").EnumMembers.Select(m => m.Value)];
        }

        var variants = properties.Field.Variants
            ?? throw new InvalidOperationException("Expected 'Properties' to carry per-class variants.");
        Assert.Contains("BodyPart", PropertyDomain(variants[nameof(ArmorModification)]));
        Assert.Contains("ForcedInventory", PropertyDomain(variants[nameof(NpcModification)]));
        Assert.Contains("AmmoCapacity", PropertyDomain(variants[nameof(WeaponModification)]));
        Assert.DoesNotContain("BodyPart", PropertyDomain(variants[nameof(NpcModification)]));
    }

    // ── OMOD's Properties element must surface the property's actual Value ──
    //
    // IAObjectModPropertyGetter<T> declares only Property/Step; the payload lives on the seven generic
    // leaves under it, named as the codec closes them.

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_ExposesSevenLeafUnionFields()
    {
        // The seven leaves' members, as one element schema.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "Properties");
        var elementSpec = properties.Field.ElementSpec
            ?? throw new InvalidOperationException("Expected 'Properties' to declare an element spec.");
        var fields = elementSpec.SubFields
            ?? throw new InvalidOperationException("Expected 'Properties' element spec to declare sub-fields.");

        var value = fields.Single(f => f.Name == "Value");
        var value2 = fields.Single(f => f.Name == "Value2");
        var record = fields.Single(f => f.Name == "Record");
        var functionType = fields.Single(f => f.Name == "FunctionType");
        var enumIntValue = fields.Single(f => f.Name == "EnumIntValue");

        // Value/Value2/FunctionType collide in CLR type across the seven leaves, so each carries a
        // variant per leaf. Record and EnumIntValue are typed alike by the leaves declaring them,
        // and the variant map names exactly those leaves.
        var valueVariants = value.Variants
            ?? throw new InvalidOperationException("Expected 'Value' to carry per-leaf variants.");
        Assert.Equal("int", valueVariants["ObjectModIntProperty<Armor+Property>"].ApiType);
        Assert.Equal("float", valueVariants["ObjectModFloatProperty<Armor+Property>"].ApiType);
        Assert.Equal("bool", valueVariants["ObjectModBoolProperty<Armor+Property>"].ApiType);
        Assert.NotNull(value2.Variants);
        Assert.NotNull(functionType.Variants);
        Assert.Equal("formKey", record.ApiType);
        var recordVariants = record.Variants
            ?? throw new InvalidOperationException("Expected 'Record' to carry per-leaf variants.");
        Assert.Equal(
            ["ObjectModFormLinkFloatProperty<Armor+Property>", "ObjectModFormLinkIntProperty<Armor+Property>"],
            recordVariants.Keys.Order(StringComparer.Ordinal));
        Assert.All(recordVariants.Values, v => Assert.Equal("formKey", v.ApiType));
        Assert.Equal("int", enumIntValue.ApiType);
        var enumIntValueVariants = enumIntValue.Variants
            ?? throw new InvalidOperationException("Expected 'EnumIntValue' to carry per-leaf variants.");
        Assert.Equal(["ObjectModEnumProperty<Armor+Property>"], enumIntValueVariants.Keys);

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
    public void GetSchemas_Glob_OutputCharColumn_ExclusiveToGlobalFloat_NamesThatOneClassAsItsVariant()
    {
        // The "not present on every sibling" branch of the fold is real today: the column belongs
        // to GlobalFloat alone, so the variant map names that class and a write to a GlobalBool is
        // refused by name.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var outputChar = schemas["glob"].RecordColumns.Single(c => c.Name == "OutputChar");

        Assert.True(outputChar.Field.AllowsNull);
        var variants = outputChar.Field.Variants
            ?? throw new InvalidOperationException("Expected 'OutputChar' to carry a per-class variant.");
        Assert.Equal([nameof(GlobalFloat)], variants.Keys);
        Assert.Equal("bool", variants[nameof(GlobalFloat)].ApiType);
        Assert.True(outputChar.IsViewable);
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
        Assert.NotEmpty(col.Field.EnumMembers);
        Assert.Contains("Unaggressive", col.Field.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void GetSchemas_Npc_FormLinkColumn_MapsToFormKeyTypeWithValidTypes()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Race");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("formKey", col.ApiType);
        Assert.Contains("race", col.Field.ValidFormKeyTypes);
    }

    [Fact]
    public void GetSchemas_Npc_Race_IsNonNullableFormLink()
    {
        // Race is IFormLink<IRaceGetter> — non-nullable; AllowsNull must be false.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Race");
        Assert.NotNull(col);
        Assert.False(col.Field.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Voice_IsNullableFormLink()
    {
        // Voice is IFormLinkNullable<IVoiceTypeGetter> — AllowsNull must be true.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Voice");
        Assert.NotNull(col);
        Assert.True(col.Field.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Faction_SubField_IsNonNullableFormLink()
    {
        // RankPlacement.Faction is IFormLink<IFactionGetter> — non-nullable sub-field.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Factions");
        Assert.NotNull(col);
        var faction = col.Field.ElementSpec?.SubFields?.FirstOrDefault(f => f.Name == "Faction");
        Assert.NotNull(faction);
        Assert.False(faction.AllowsNull);
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
        Assert.NotNull(col.Field.ElementSpec);
        Assert.Equal("formKey", col.Field.ElementSpec.ApiType);
        Assert.Contains("kywd", col.Field.ElementSpec.ValidFormKeyTypes);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_IsReflectedAsArrayOfStructs()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Factions");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.Field.ElementSpec);
        Assert.Equal("struct", col.Field.ElementSpec.ApiType);
        var fields = col.Field.ElementSpec.SubFields;
        Assert.NotNull(fields);
        Assert.Contains(fields, f => f.Name == "Faction" && f.ApiType == "formKey");
        Assert.Contains(fields, f => f.Name == "Rank" && f.ApiType == "int");
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

    // ── Array Apply ───────────────────────────────────────────────────────────

    // ── IsFormLink requires both IsInterface AND IsGenericType ─────────────────

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
        Assert.Equal(expectedApiType, topCol.ApiType);
        Assert.Equal(expectedDuckDbType, topCol.DuckDbType);

        var structCol = npc.RecordColumns.FirstOrDefault(c => c.Name == structOrArrayColumn);
        Assert.NotNull(structCol);

        IReadOnlyList<SubFieldSpec>? subFields = isArray
            ? structCol.Field.ElementSpec?.SubFields
            : structCol.Field.SubFields;

        Assert.NotNull(subFields);
        var subField = subFields.FirstOrDefault(f => f.Name == subFieldName);
        Assert.NotNull(subField);
        Assert.Equal(expectedApiType, subField.ApiType);
    }

    // ── Bitmask / [Flags] enum support ────────────────────────────

    [Fact]
    public void GetSchemas_Npc_FlagColumn_IsAFlagsLeaf_TheCodecSpellsAsNames()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Flags");
        Assert.NotNull(col);
        Assert.Equal("flags", col.ApiType);
        Assert.Equal("VARCHAR", col.DuckDbType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_IsAPlainEnum()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Aggression");
        Assert.NotNull(col);
        Assert.Equal("enum", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_EnumColumn_MembersCarryNoBit()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Aggression");
        Assert.NotNull(col);
        Assert.All(col.Field.EnumMembers, m => Assert.Null(m.BitValue));
    }

    [Fact]
    public void GetSchemas_FlagColumn_EveryMemberCarriesAnAtomicBit()
    {
        // GetEnumMembers must filter out None=0 and composite values — only atomic power-of-two bits
        // should appear.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Flags");
        Assert.NotNull(col);
        Assert.NotEmpty(col.Field.EnumMembers);
        Assert.All(col.Field.EnumMembers, m =>
        {
            var bitValue = m.BitValue;
            Assert.NotNull(bitValue);
            long v = long.Parse(bitValue, System.Globalization.CultureInfo.InvariantCulture);
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
        var col = schemas["race"].RecordColumns.Single(c => c.Name == "Flags");
        var bits = col.Field.EnumMembers.Select(m => m.BitValue).ToList();
        Assert.Contains("9007199254740992", bits);   // LowPriorityPushable = 2^53
        Assert.Contains("18014398509481984", bits);  // CannotUsePlayableItems = 2^54
        Assert.Contains("1", bits);                   // Playable (low-bit sanity check)
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
        Assert.Equal("flags", col.ApiType);
        Assert.All(col.Field.EnumMembers, m => Assert.Null(m.BitValue));
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
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "Author");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("string", col.ApiType);
    }

    [Fact]
    public void GetSchemas_Header_FlagsColumn_CarriesMutagensNamesLabelledWithXEdits()
    {
        // The document spells the header's flags by Mutagen's member names; xEdit's vocabulary is
        // the label, never the value (presentation never rewrites a value).
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "Flags");
        Assert.NotNull(col);
        Assert.Equal("flags", col.ApiType);
        Assert.Equal("ESM", col.Field.EnumMembers.Single(m => m.Value == "Master").Label);
        Assert.Equal("ESL", col.Field.EnumMembers.Single(m => m.Value == "Small").Label);
        Assert.Null(col.Field.EnumMembers.Single(m => m.Value == "Localized").Label);
        Assert.DoesNotContain(col.Field.EnumMembers, m => m.Value is "ESM" or "ESL");
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_IsTheDocumentsOwnMasterReferences()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "MasterReferences");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.Equal("ModHeader.MasterReferences", col.PropertyName);
        var elementSpec = col.Field.ElementSpec;
        Assert.NotNull(elementSpec);
        Assert.Equal("struct", elementSpec.ApiType);
        var subFields = elementSpec.SubFields;
        Assert.NotNull(subFields);
        Assert.Contains(subFields, f => f.Name == "Master" && f.ApiType == "string");
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_ToFieldMetadata_IsArrayTrue()
    {
        // The column itself must be flagged as an array (not just ApiType == "array") — this is
        // what the frontend's array rows key off to render masters as a repeatable list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.Single(c => c.Name == "MasterReferences");
        Assert.True(col.ToFieldMetadata().IsArray);
    }

    [Fact]
    public void GetSchemas_Header_MastersColumn_ElementType_IsNotItselfAnArray()
    {
        // Each master is a single plugin-filename string, not a nested array — the element
        // FieldMetadata's own IsArray must be false, or the frontend would try to render each
        // master entry as a further repeatable list.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.Single(c => c.Name == "MasterReferences");
        var elementSpec = col.Field.ElementSpec;
        Assert.NotNull(elementSpec);
        Assert.False(elementSpec.IsArray);
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
        Assert.Contains(columns, c => c.Name == "Conditions" && c.ApiType == "array");
    }

    [Fact]
    public void GetSchemas_Perk_EffectsProperty_StillGetsGenericArrayColumn()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var columns = schemas["perk"].RecordColumns;
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
        Assert.Equal("struct", col.ApiType);

        Assert.Equal("vector", col.Field.SubFields?.FirstOrDefault(f => f.Name == "First")?.ApiType);
        Assert.Equal("vector", col.Field.SubFields?.FirstOrDefault(f => f.Name == "Second")?.ApiType);
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

        var resistances = destructible.Field.SubFields?.FirstOrDefault(f => f.Name == "Resistances");
        Assert.NotNull(resistances);
        Assert.Equal("array", resistances.ApiType);
        Assert.True(resistances.IsArray);

        var stages = destructible.Field.SubFields?.FirstOrDefault(f => f.Name == "Stages");
        Assert.NotNull(stages);
        Assert.Equal("array", stages.ApiType);
        Assert.True(stages.IsArray);
        var stagesElementSpec = stages.ElementSpec
            ?? throw new InvalidOperationException("Expected 'Stages' to declare an element spec.");
        var stagesSubFields = stagesElementSpec.SubFields
            ?? throw new InvalidOperationException("Expected 'Stages' element spec to declare sub-fields.");
        Assert.Contains(stagesSubFields, f => f.Name == "HealthPercent");
    }

    // ── P3Float, both dispatch paths, on fixtures with no side-table row ──────────────────────

    [Fact]
    public void GetSchemas_MaterialObject_HasProjectionVectorColumn_AsAVectorLeaf()
    {
        // MaterialObject.ProjectionVector is a direct top-level P3Float column (GetColumnInfo path)
        // with no side-table row — unlike Placed*.Position (see the edit gesture's companion
        // refusal), safe to make writable unconditionally.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["mato"].RecordColumns.FirstOrDefault(c => c.Name == "ProjectionVector");
        Assert.NotNull(col);
        Assert.Equal("vector", col.ApiType);
        Assert.Null(col.Field.SubFields);
    }

    [Fact]
    public void GetSchemas_PlacedObject_TeleportDestination_HasPositionRotationVectorSubFields()
    {
        // PlacedObject.TeleportDestination.Position/Rotation — P3Float nested one level inside a
        // struct (GetSubFieldInfo path), never mirrored anywhere else, so safe unconditionally too.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var teleport = schemas["refr"].RecordColumns.FirstOrDefault(c => c.Name == "TeleportDestination");
        Assert.NotNull(teleport);

        Assert.Equal("vector", teleport.Field.SubFields?.FirstOrDefault(f => f.Name == "Position")?.ApiType);
        Assert.Equal("vector", teleport.Field.SubFields?.FirstOrDefault(f => f.Name == "Rotation")?.ApiType);
    }

    // ── Noggog's small value-vector struct family, beyond P3Int16/P3Float ──────────────────────

    [Fact]
    public void GetSchemas_Cell_HasGridColumn_WithFlagsAndPointSubFields()
    {
        // Cell.Grid.Point is a Noggog.P2Int, which a ClassifyLeaf limited to P3Int16/P3Float maps
        // not at all.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cell"].RecordColumns.FirstOrDefault(c => c.Name == "Grid");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
        var subFields = col.Field.SubFields
            ?? throw new InvalidOperationException("Expected 'Grid' to declare sub-fields.");
        Assert.Equal(2, subFields.Count);

        Assert.Contains(subFields, f => f.Name == "Flags" && f.ApiType is "enum" or "Flags");
        Assert.Contains(subFields, f => f.Name == "Point" && f.ApiType == "vector");
    }

    [Fact]
    public void GetSchemas_Location_WorldspaceCellsAdded_ElementHasCoordinatesListOfVectors()
    {
        // LocationCoordinate.Coordinates is a list nested inside a struct that is itself a list
        // element, composing the struct-nested-list arm with the widened vector-struct set.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["lctn"].RecordColumns.FirstOrDefault(c => c.Name == "WorldspaceCellsAdded");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);

        var coordinates = col.Field.ElementSpec?.SubFields?.FirstOrDefault(f => f.Name == "Coordinates");
        Assert.NotNull(coordinates);
        Assert.True(coordinates.IsArray);
        var coordinatesElementSpec = coordinates.ElementSpec
            ?? throw new InvalidOperationException("Expected 'Coordinates' to declare an element spec.");
        Assert.Equal("vector", coordinatesElementSpec.ApiType);
    }

}
