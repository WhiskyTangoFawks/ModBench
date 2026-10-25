using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public class SchemaReflectorTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    [Theory]
    [InlineData("parw", "Placed Arrow")]
    [InlineData("pbar", "Placed Barrier")]
    [InlineData("pbea", "Placed Beam")]
    [InlineData("pcon", "Placed Cone/Voice")]
    [InlineData("pfla", "Placed Flame")]
    [InlineData("pgre", "Placed Projectile")]
    [InlineData("phzd", "Placed Hazard")]
    [InlineData("pmis", "Placed Missile")]
    public void APlacedVariant_IsATableUnderXEditsName(string table, string displayName)
    {
        Assert.Equal(displayName, _reflector.GetSchemas(GameRelease.Fallout4).DisplayNameFor(table));
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "acti", "Activator")]
    [InlineData(GameRelease.Fallout4, "gmst", "Game Setting")]
    [InlineData(GameRelease.Fallout4, "idle", "Idle Animation")]
    [InlineData(GameRelease.Starfield, "idle", "Animation")]
    public void ARecordTypesName_IsTheOneItsGamesXEditGivesIt(GameRelease release, string table, string displayName)
    {
        Assert.Equal(displayName, _reflector.GetSchemas(release).DisplayNameFor(table));
    }

    [Fact]
    public void AnObjectModsProperties_CarryEachRecordClassOwnPropertyDomain_BecauseEachClassesPropertiesElementClosesOverItsOwnT()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "Properties");

        static List<string> PropertyDomain(FieldMetadata variant)
        {
            var elementSpec = variant.ElementType
                ?? throw new InvalidOperationException("Expected a variant to declare an element spec.");
            var subFields = elementSpec.Fields
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
    public void AnObjectModPropertyElement_ExposesSevenLeafUnionFields_BecauseTheGetterInterfaceDeclaresOnlyPropertyAndStepAndThePayloadLivesOnTheSevenGenericLeavesNamedAsTheCodecClosesThem()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var properties = schemas["omod"].RecordColumns.Single(c => c.Name == "Properties");
        var elementSpec = properties.Field.ElementType
            ?? throw new InvalidOperationException("Expected 'Properties' to declare an element spec.");
        var fields = elementSpec.Fields
            ?? throw new InvalidOperationException("Expected 'Properties' element spec to declare sub-fields.");

        var value = fields.Single(f => f.Name == "Value");
        var value2 = fields.Single(f => f.Name == "Value2");
        var record = fields.Single(f => f.Name == "Record");
        var functionType = fields.Single(f => f.Name == "FunctionType");
        var enumIntValue = fields.Single(f => f.Name == "EnumIntValue");

        var valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves = value.Variants
            ?? throw new InvalidOperationException("Expected 'Value' to carry per-leaf variants.");
        Assert.Equal("int", valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves["ObjectModIntProperty<Armor+Property>"].Type);
        Assert.Equal("float", valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves["ObjectModFloatProperty<Armor+Property>"].Type);
        Assert.Equal("bool", valueVariantsBecauseValueValue2AndFunctionTypeCollideInClrTypeAcrossTheSevenLeaves["ObjectModBoolProperty<Armor+Property>"].Type);
        Assert.NotNull(value2.Variants);
        Assert.NotNull(functionType.Variants);
        Assert.Equal("formKey", record.Type);
        var recordVariantsNamingExactlyTheLeavesDeclaringItBecauseTheyTypeItAlike = record.Variants
            ?? throw new InvalidOperationException("Expected 'Record' to carry per-leaf variants.");
        Assert.Equal(
            ["ObjectModFormLinkFloatProperty<Armor+Property>", "ObjectModFormLinkIntProperty<Armor+Property>"],
            recordVariantsNamingExactlyTheLeavesDeclaringItBecauseTheyTypeItAlike.Keys.Order(StringComparer.Ordinal));
        Assert.All(recordVariantsNamingExactlyTheLeavesDeclaringItBecauseTheyTypeItAlike.Values, v => Assert.Equal("formKey", v.Type));
        Assert.Equal("int", enumIntValue.Type);
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
    public void AGlobalsOutputChar_ExclusiveToGlobalFloat_NamesThatOneClassAsItsVariant_TheNotPresentOnEverySiblingBranchOfTheFoldBeingRealToday()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var outputChar = schemas["glob"].RecordColumns.Single(c => c.Name == "OutputChar");

        Assert.True(outputChar.Field.AllowsNull);
        var variants = outputChar.Field.Variants
            ?? throw new InvalidOperationException("Expected 'OutputChar' to carry a per-class variant.");
        Assert.Equal([nameof(GlobalFloat)], variants.Keys);
        Assert.Equal("bool", variants[nameof(GlobalFloat)].Type);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void EveryDiscoveredTable_HasANonEmptyDisplayName_DifferentFromItsKeyBecauseRecordDisplayNamesForFallsBackToTheRawSignatureOnALookupMiss(GameRelease release)
    {
        var schemas = _reflector.GetSchemas(release);
        var missing = schemas
            .Where(kv => string.IsNullOrEmpty(schemas.DisplayNameFor(kv.Key)) || schemas.DisplayNameFor(kv.Key) == kv.Key)
            .Select(kv => kv.Key)
            .ToList();
        Assert.Empty(missing);
    }

    [Theory]
    [InlineData("npc_", "Race", false)]
    [InlineData("npc_", "Voice", true)]
    [InlineData("npc_", "Factions.[].Faction", false)]
    public void AFormLinkAllowsNull_ExactlyWhenItsPropertyIsNullable(string table, string path, bool allowsNull) =>
        Assert.Equal(allowsNull, SchemaFields.At(GameRelease.Fallout4, table, path).AllowsNull);

    [Fact]
    public void AnEnumsMembers_AreItsValues_CarryingNoBit()
    {
        var aggression = SchemaFields.At(GameRelease.Fallout4, "npc_", "Aggression");

        Assert.Contains("Unaggressive", aggression.EnumMembers.Select(m => m.Value));
        Assert.All(aggression.EnumMembers, m => Assert.Null(m.BitValue));
    }

    [Fact]
    public void AFormLink_NamesTheTablesItMayPointAt()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Race");
        Assert.NotNull(col);
        Assert.Equal("formKey", col.ApiType);
        Assert.Contains("race", col.Field.ValidFormKeyTypes);
    }

    [Fact]
    public void AListOfLinks_IsAnArrayOfFormKeys_EachNamingTheTablesItMayPointAt()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Keywords");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.Field.ElementType);
        Assert.Equal("formKey", col.Field.ElementType.Type);
        Assert.Contains("kywd", col.Field.ElementType.ValidFormKeyTypes);
    }

    [Fact]
    public void AListOfStructs_IsAnArrayOfStructs_HoldingTheirMembers()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["npc_"].RecordColumns.FirstOrDefault(c => c.Name == "Factions");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.NotNull(col.Field.ElementType);
        Assert.Equal("struct", col.Field.ElementType.Type);
        var fields = col.Field.ElementType.Fields;
        Assert.NotNull(fields);
        Assert.Contains(fields, f => f.Name == "Faction" && f.Type == "formKey");
        Assert.Contains(fields, f => f.Name == "Rank" && f.Type == "int");
    }

    [Theory]
    [InlineData("HeightMin", "Weight.Thin", "float")]
    [InlineData("XpValueOffset", "Factions.[].Rank", "int")]
    [InlineData("Race", "Factions.[].Faction", "formKey")]
    [InlineData("Aggression", "FaceTintingLayers.[].DataType", "enum")]
    public void AMemberOfAStructOrAnArrayElement_IsTheKindAColumnOfItsTypeIs(string column, string member, string kind)
    {
        Assert.Equal(kind, SchemaFields.At(GameRelease.Fallout4, "npc_", column).Type);
        Assert.Equal(kind, SchemaFields.At(GameRelease.Fallout4, "npc_", member).Type);
    }

    [Fact]
    public void AFlagsMembers_EachCarryAnAtomicBit_BecauseGetEnumMembersFiltersOutNoneZeroAndCompositeValues()
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
    public void ARacesFlags_UlongBackedBitsBeyondJsMaxSafeInteger_SerializedAsStringsSoTheFrontendParsesThemAsBigInt()
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

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    public void AHeadersFlags_CarryMutagensNamesLabelledWithXEdits_XEditsVocabularyIsTheLabelNeverTheValueSincePresentationNeverRewritesAValue(GameRelease release)
    {
        var schemas = _reflector.GetSchemas(release);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "Flags");
        Assert.NotNull(col);
        Assert.Equal("flags", col.ApiType);
        Assert.Equal("ESM", col.Field.EnumMembers.Single(m => m.Value == "Master").Label);
        Assert.Equal("ESL", col.Field.EnumMembers.Single(m => m.Value == "Small").Label);
        Assert.Null(col.Field.EnumMembers.Single(m => m.Value == "Localized").Label);
        Assert.DoesNotContain(col.Field.EnumMembers, m => m.Value is "ESM" or "ESL");
    }

    [Fact]
    public void AStarfieldHeadersFlags_CarryMutagensNamesLabelledWithXEdits()
    {
        var flags = _reflector.GetSchemas(GameRelease.Starfield)["header"].RecordColumns.Single(c => c.Name == "Flags").Field;

        Assert.Equal("Small", flags.EnumMembers.Single(m => m.Value == "Light").Label);
        Assert.Equal("Update", flags.EnumMembers.Single(m => m.Value == "Overlay").Label);
        Assert.Null(flags.EnumMembers.Single(m => m.Value == "Master").Label);
        Assert.Null(flags.EnumMembers.Single(m => m.Value == "Medium").Label);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void AHeader_PresentsTheLightMasterFlagAsAMemberOfItsOwn(GameRelease release)
    {
        var header = _reflector.GetSchemas(release)["header"];

        Assert.Equal("bool", header.RecordColumns.Single(c => c.Name == "IsSmallMaster").ApiType);
    }

    [Fact]
    public void AHeadersMasters_AreTheDocumentsOwnMasterReferences()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["header"].RecordColumns.FirstOrDefault(c => c.Name == "MasterReferences");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);
        Assert.Equal("ModHeader.MasterReferences", col.PropertyName);
        var elementSpec = col.Field.ElementType;
        Assert.NotNull(elementSpec);
        Assert.Equal("struct", elementSpec.Type);
        var subFields = elementSpec.Fields;
        Assert.NotNull(subFields);
        Assert.Contains(subFields, f => f.Name == "Master" && f.Type == "string");
    }

    [Fact]
    public void AHeadersMasters_AreReadOnly_ThroughEveryMemberBelow_AsCompileDerivesThem()
    {
        var masters = SchemaFields.Below("MasterReferences", SchemaFields.At(GameRelease.Fallout4, "header", "MasterReferences")).ToList();

        Assert.Contains(masters, member => member.Path == "MasterReferences[].Master");
        Assert.All(masters, member => Assert.Equal("masters are wholly content-derived at compile time", member.Field.ReadOnlyReason));
    }

    [Fact]
    public void AContainersObjectBounds_HoldFirstAndSecondVectors_BecauseNoggogP3Int16IsAVectorLeafTheCodecSpellsAsXYZTextNotDroppedAsUnclassified()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cont"].RecordColumns.FirstOrDefault(c => c.Name == "ObjectBounds");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);

        Assert.Equal("vector", col.Field.Fields?.FirstOrDefault(f => f.Name == "First")?.Type);
        Assert.Equal("vector", col.Field.Fields?.FirstOrDefault(f => f.Name == "Second")?.Type);
    }

    [Fact]
    public void AContainersDestructible_HoldsResistancesAndStagesArrays_ListsNestedInsideAStructNotDropped()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var destructible = schemas["cont"].RecordColumns.First(c => c.Name == "Destructible");

        var resistances = destructible.Field.Fields?.FirstOrDefault(f => f.Name == "Resistances");
        Assert.NotNull(resistances);
        Assert.Equal("array", resistances.Type);

        var stages = destructible.Field.Fields?.FirstOrDefault(f => f.Name == "Stages");
        Assert.NotNull(stages);
        Assert.Equal("array", stages.Type);
        var stagesElementSpec = stages.ElementType
            ?? throw new InvalidOperationException("Expected 'Stages' to declare an element spec.");
        var stagesSubFields = stagesElementSpec.Fields
            ?? throw new InvalidOperationException("Expected 'Stages' element spec to declare sub-fields.");
        Assert.Contains(stagesSubFields, f => f.Name == "HealthPercent");
    }

    [Fact]
    public void APlacedObjectsTeleportDestination_HoldsPositionAndRotationVectors_ChosenBecauseItIsNeverMirroredElsewhereSoIsSafeToMakeWritableUnconditionally()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var teleport = schemas["refr"].RecordColumns.FirstOrDefault(c => c.Name == "TeleportDestination");
        Assert.NotNull(teleport);

        Assert.Equal("vector", teleport.Field.Fields?.FirstOrDefault(f => f.Name == "Position")?.Type);
        Assert.Equal("vector", teleport.Field.Fields?.FirstOrDefault(f => f.Name == "Rotation")?.Type);
    }

    [Fact]
    public void ACellsGrid_HoldsFlagsAndAPointVector_ChosenBecausePointIsANoggogP2IntBeyondP3Int16AndP3Float()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["cell"].RecordColumns.FirstOrDefault(c => c.Name == "Grid");
        Assert.NotNull(col);
        Assert.Equal("struct", col.ApiType);
        var subFields = col.Field.Fields
            ?? throw new InvalidOperationException("Expected 'Grid' to declare sub-fields.");
        Assert.Equal(2, subFields.Count);

        Assert.Contains(subFields, f => f.Name == "Flags" && f.Type is "enum" or "Flags");
        Assert.Contains(subFields, f => f.Name == "Point" && f.Type == "vector");
    }

    [Fact]
    public void ALocationsWorldspaceCellsAdded_ElementHoldsCoordinatesListOfVectors_ComposingTheStructNestedListArmWithTheWidenedVectorStructSet()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var col = schemas["lctn"].RecordColumns.FirstOrDefault(c => c.Name == "WorldspaceCellsAdded");
        Assert.NotNull(col);
        Assert.Equal("array", col.ApiType);

        var coordinates = col.Field.ElementType?.Fields?.FirstOrDefault(f => f.Name == "Coordinates");
        Assert.NotNull(coordinates);
        Assert.Equal("array", coordinates.Type);
        var coordinatesElementSpec = coordinates.ElementType
            ?? throw new InvalidOperationException("Expected 'Coordinates' to declare an element spec.");
        Assert.Equal("vector", coordinatesElementSpec.Type);
    }
}
