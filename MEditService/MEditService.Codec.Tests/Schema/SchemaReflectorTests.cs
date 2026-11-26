using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public class SchemaReflectorTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    [Theory]
    [InlineData(GameRelease.Fallout4, "acti", "Activator")]
    [InlineData(GameRelease.Fallout4, "parw", "Placed Arrow")]
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

    [Theory]
    [InlineData("Race", "race")]
    [InlineData("Keywords.[]", "kywd")]
    public void ALink_NamesTheTablesItMayPointAt_AsDoesEachLinkOfAList(string path, string table)
    {
        var link = SchemaFields.At(GameRelease.Fallout4, "npc_", path);

        Assert.Equal("formKey", link.Type);
        Assert.Contains(table, link.ValidFormKeyTypes);
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

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.Starfield)]
    public void ATemplateFlags_ArePlainEnumsInMutagen_SoTheirMembersCarryTheBitsTheDocumentsNumberIsMadeOf(GameRelease release)
    {
        var field = SchemaFields.At(release, "npc_", "UseTemplateActors");
        Assert.Equal("enum", field.Type);
        Assert.Equal(["1", "2", "4"], field.EnumMembers.Take(3).Select(m => m.BitValue));
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
    [InlineData(GameRelease.Starfield)]
    public void AHeader_PresentsTheLightMasterFlagAsAMemberOfItsOwn(GameRelease release)
    {
        var header = _reflector.GetSchemas(release)["header"];

        Assert.Equal("bool", header.RecordColumns.Single(c => c.Name == "IsSmallMaster").ApiType);
    }

    [Fact]
    public void AHeadersMasters_AreReadOnly_ThroughEveryMemberBelow_AsCompileDerivesThem()
    {
        var masters = SchemaFields.Below("MasterReferences", SchemaFields.At(GameRelease.Fallout4, "header", "MasterReferences")).ToList();

        Assert.Contains(masters, member => member.Path == "MasterReferences[].Master");
        Assert.All(masters, member => Assert.Equal("masters are wholly content-derived at compile time", member.Field.ReadOnlyReason));
    }
}
