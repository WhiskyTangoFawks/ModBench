using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public class SchemaReflectorTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    [Theory]
    [InlineData("parw", typeof(IPlacedArrowGetter), "Placed Arrow")]
    [InlineData("pbar", typeof(IPlacedBarrierGetter), "Placed Barrier")]
    [InlineData("pbea", typeof(IPlacedBeamGetter), "Placed Beam")]
    [InlineData("pcon", typeof(IPlacedConeGetter), "Placed Cone/Voice")]
    [InlineData("pfla", typeof(IPlacedFlameGetter), "Placed Flame")]
    [InlineData("pgre", typeof(IPlacedTrapGetter), "Placed Projectile")]
    [InlineData("phzd", typeof(IPlacedHazardGetter), "Placed Hazard")]
    [InlineData("pmis", typeof(IPlacedMissileGetter), "Placed Missile")]
    public void APlacedVariant_IsATableOfItsOwnType_UnderXEditsName(string table, Type getter, string displayName)
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);

        Assert.Equal(getter, schemas[table].RecordType);
        Assert.Equal(displayName, schemas.DisplayNameFor(table));
    }

    [Fact]
    public void GetSchemas_Acti_DisplayName_MatchesXEdit()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.Equal("Activator", schemas.DisplayNameFor("acti"));
    }

    [Fact]
    public void GetSchemas_Gmst_DisplayName_MatchesXEdit()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        Assert.Equal("Game Setting", schemas.DisplayNameFor("gmst"));
    }

    [Fact]
    public void GetSchemas_Omod_PropertiesColumn_CarriesEachRecordClassOwnPropertyDomain_BecauseEachClassesPropertiesElementClosesOverItsOwnT()
    {
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

    [Fact]
    public void GetSchemas_Omod_PropertiesElement_ExposesSevenLeafUnionFields_BecauseTheGetterInterfaceDeclaresOnlyPropertyAndStepAndThePayloadLivesOnTheSevenGenericLeavesNamedAsTheCodecClosesThem()
    {
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

        var valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves = value.Variants
            ?? throw new InvalidOperationException("Expected 'Value' to carry per-leaf variants.");
        Assert.Equal("int", valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves["ObjectModIntProperty<Armor+Property>"].ApiType);
        Assert.Equal("float", valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves["ObjectModFloatProperty<Armor+Property>"].ApiType);
        Assert.Equal("bool", valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves["ObjectModBoolProperty<Armor+Property>"].ApiType);
        Assert.NotNull(value2.Variants);
        Assert.NotNull(functionType.Variants);
        Assert.Equal("formKey", record.ApiType);
        var recordVariantsNamingExactlyTheLeavesDeclaringItBecauseTheyTypeItAlike = record.Variants
            ?? throw new InvalidOperationException("Expected 'Record' to carry per-leaf variants.");
        Assert.Equal(
            ["ObjectModFormLinkFloatProperty<Armor+Property>", "ObjectModFormLinkIntProperty<Armor+Property>"],
            recordVariantsNamingExactlyTheLeavesDeclaringItBecauseTheyTypeItAlike.Keys.Order(StringComparer.Ordinal));
        Assert.All(recordVariantsNamingExactlyTheLeavesDeclaringItBecauseTheyTypeItAlike.Values, v => Assert.Equal("formKey", v.ApiType));
        Assert.Equal("int", enumIntValue.ApiType);
        var enumIntValueVariants = enumIntValue.Variants
            ?? throw new InvalidOperationException("Expected 'EnumIntValue' to carry per-leaf variants.");
        Assert.Equal(["ObjectModEnumProperty<Armor+Property>"], enumIntValueVariants.Keys);

        var sparseFieldsDeclaredBySomeLeavesNotAllSoANonDeclaringLeafsRowsLegitimatelyReadNull = new[] { value, value2, record, functionType, enumIntValue };
        var sparseFieldsThatDisallowNull = sparseFieldsDeclaredBySomeLeavesNotAllSoANonDeclaringLeafsRowsLegitimatelyReadNull
            .Where(f => !f.AllowsNull).Select(f => f.Name).ToList();
        Assert.Empty(sparseFieldsThatDisallowNull);

        const string UnusedWhichMutagenNamesAndXEditsWbUnusedNeverRendersAsAFieldBothAgreeItCarriesNoProductVisibleData = "Unused";
        Assert.DoesNotContain(fields, f => f.Name == UnusedWhichMutagenNamesAndXEditsWbUnusedNeverRendersAsAFieldBothAgreeItCarriesNoProductVisibleData);
    }

    [Fact]
    public void GetSchemas_Glob_OutputCharColumn_ExclusiveToGlobalFloat_NamesThatOneClassAsItsVariant_TheNotPresentOnEverySiblingBranchOfTheFoldBeingRealToday()
    {
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
    public void GetSchemas_EveryDiscoveredTable_HasANonEmptyDisplayName_DifferentFromItsKeyBecauseRecordDisplayNamesForFallsBackToTheRawSignatureOnALookupMiss()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var missing = schemas
            .Where(kv => string.IsNullOrEmpty(schemas.DisplayNameFor(kv.Key)) || schemas.DisplayNameFor(kv.Key) == kv.Key)
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
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Race");
        Assert.NotNull(col);
        Assert.False(col.Field.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Voice_IsNullableFormLink()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Voice");
        Assert.NotNull(col);
        Assert.True(col.Field.AllowsNull);
    }

    [Fact]
    public void GetSchemas_Npc_Factions_Faction_SubField_IsNonNullableFormLink()
    {
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
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Name");
        Assert.NotNull(col);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.Equal("translatedString", col.ApiType);
    }

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
    public void GetSchemas_Npc_Weight_IsStructNotFormkey_BecauseINpcWeightGetterIsANonGenericInterfaceAndIsFormLinkRequiresBothInterfaceAndGeneric()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Weight");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
    }

    [Fact]
    public void GetSchemas_ImageSpaceAdapter_UInt64Column_MapsToBigInt()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["imad"].RecordColumns.FirstOrDefault(c => c.Name == "Unknown");
        Assert.NotNull(col);
        Assert.Equal("BIGINT", col.DuckDbType);
        Assert.Equal("int", col.ApiType);
    }

    [Theory]
    [InlineData("HeightMin", "float", "FLOAT", "Weight", false, "Thin")]
    [InlineData("XpValueOffset", "int", "INTEGER", "Factions", true, "Rank")]
    [InlineData("Race", "formKey", "VARCHAR", "Factions", true, "Faction")]
    [InlineData("Aggression", "enum", "VARCHAR", "FaceTintingLayers", true, "DataType")]
    public void GetSchemas_PrimitiveType_ColumnAndSubFieldBothReflected_ASubFieldOfEachPrimitiveTypeMapsAsItsTopLevelColumnDoes(
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
    public void GetSchemas_FlagColumn_EveryMemberCarriesAnAtomicBit_BecauseGetEnumMembersFiltersOutNoneZeroAndCompositeValues()
    {
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
    public void GetSchemas_Race_FlagColumn_UlongBackedBitsBeyondJsMaxSafeInteger_SerializedAsStringsSoTheFrontendParsesThemAsBigInt()
    {
        const string LowPriorityPushable2Pow53 = "9007199254740992";
        const string CannotUsePlayableItems2Pow54 = "18014398509481984";
        const string PlayableLowBitSanityCheck = "1";
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["race"].RecordColumns.Single(c => c.Name == "Flags");
        var bits = col.Field.EnumMembers.Select(m => m.BitValue).ToList();
        Assert.Contains(LowPriorityPushable2Pow53, bits);
        Assert.Contains(CannotUsePlayableItems2Pow54, bits);
        Assert.Contains(PlayableLowBitSanityCheck, bits);
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
    public void GetSchemas_Header_FlagsColumn_CarriesMutagensNamesLabelledWithXEdits_XEditsVocabularyIsTheLabelNeverTheValueSincePresentationNeverRewritesAValue()
    {
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
    public void GetSchemas_Header_RecordType_IsHeaderGetterInterface_NotAMajorRecordType_BecauseTheEnumerateMajorRecordsLoopAssumesAnIMajorRecordGetter()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["header"];
        Assert.False(typeof(Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter).IsAssignableFrom(schema.RecordType));
    }

    [Fact]
    public void GetSchemas_Container_HasObjectBoundsColumn_WithFirstSecondVectorSubFields_BecauseNoggogP3Int16IsAVectorLeafTheCodecSpellsAsXYZTextNotDroppedAsUnclassified()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.FirstOrDefault(c => c.Name == "ObjectBounds");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);

        Assert.Equal("vector", col.Field.SubFields?.FirstOrDefault(f => f.Name == "First")?.ApiType);
        Assert.Equal("vector", col.Field.SubFields?.FirstOrDefault(f => f.Name == "Second")?.ApiType);
    }

    [Fact]
    public void GetSchemas_Container_Destructible_HasResistancesAndStagesArraySubFields_ListsNestedInsideAStructNotDropped()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var destructible = schemas["cont"].RecordColumns.First(c => c.Name == "Destructible");

        var resistances = destructible.Field.SubFields?.FirstOrDefault(f => f.Name == "Resistances");
        Assert.NotNull(resistances);
        Assert.Equal("array", resistances.ApiType);

        var stages = destructible.Field.SubFields?.FirstOrDefault(f => f.Name == "Stages");
        Assert.NotNull(stages);
        Assert.Equal("array", stages.ApiType);
        var stagesElementSpec = stages.ElementSpec
            ?? throw new InvalidOperationException("Expected 'Stages' to declare an element spec.");
        var stagesSubFields = stagesElementSpec.SubFields
            ?? throw new InvalidOperationException("Expected 'Stages' element spec to declare sub-fields.");
        Assert.Contains(stagesSubFields, f => f.Name == "HealthPercent");
    }

    [Fact]
    public void GetSchemas_MaterialObject_HasProjectionVectorColumn_AsAVectorLeaf_ChosenBecauseItHasNoSideTableRowUnlikePlacedPositionSoIsSafeToMakeWritableUnconditionally()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["mato"].RecordColumns.FirstOrDefault(c => c.Name == "ProjectionVector");
        Assert.NotNull(col);
        Assert.Equal("vector", col.ApiType);
        Assert.Null(col.Field.SubFields);
    }

    [Fact]
    public void GetSchemas_PlacedObject_TeleportDestination_HasPositionRotationVectorSubFields_ChosenBecauseItIsNeverMirroredElsewhereSoIsSafeToMakeWritableUnconditionally()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var teleport = schemas["refr"].RecordColumns.FirstOrDefault(c => c.Name == "TeleportDestination");
        Assert.NotNull(teleport);

        Assert.Equal("vector", teleport.Field.SubFields?.FirstOrDefault(f => f.Name == "Position")?.ApiType);
        Assert.Equal("vector", teleport.Field.SubFields?.FirstOrDefault(f => f.Name == "Rotation")?.ApiType);
    }

    [Fact]
    public void GetSchemas_Cell_HasGridColumn_WithFlagsAndPointSubFields_ChosenBecausePointIsANoggogP2IntBeyondP3Int16AndP3Float()
    {
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
    public void GetSchemas_Location_WorldspaceCellsAdded_ElementHasCoordinatesListOfVectors_ComposingTheStructNestedListArmWithTheWidenedVectorStructSet()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["lctn"].RecordColumns.FirstOrDefault(c => c.Name == "WorldspaceCellsAdded");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);

        var coordinates = col.Field.ElementSpec?.SubFields?.FirstOrDefault(f => f.Name == "Coordinates");
        Assert.NotNull(coordinates);
        Assert.Equal("array", coordinates.ApiType);
        var coordinatesElementSpec = coordinates.ElementSpec
            ?? throw new InvalidOperationException("Expected 'Coordinates' to declare an element spec.");
        Assert.Equal("vector", coordinatesElementSpec.ApiType);
    }
}
