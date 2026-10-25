using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using SkyrimRecords = Mutagen.Bethesda.Skyrim;
using StarfieldRecords = Mutagen.Bethesda.Starfield;

namespace MEditService.Codec.Tests.Schema;

public sealed class FunctionLeafConditionSchemaTests
{
    private static FieldMetadata Data(GameRelease release, string table, string column) => SchemaFields.At(release, table, $"{column}.[].Data");

    private static FieldMetadata Member(FieldMetadata owner, string name) => owner.Fields.Require().Single(f => f.Name == name);

    private static FieldMetadata SkyrimData() => Data(GameRelease.SkyrimSE, "perk", "Conditions");

    private static FieldMetadata StarfieldData() => Data(GameRelease.Starfield, "qust", "DialogConditions");

    [Theory]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", nameof(SkyrimRecords.GetIsIDConditionData), "GetIsID")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", nameof(SkyrimRecords.EPMagic_SpellHasKeywordConditionData), "EPMagic_SpellHasKeyword")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", nameof(SkyrimRecords.GetVATSValueWeaponConditionData), "GetVATSValueWeapon")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", nameof(SkyrimRecords.UnknownConditionData), "Unknown")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", nameof(StarfieldRecords.GetIsIDConditionData), "GetIsID")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", nameof(StarfieldRecords.GetWantBlockingConditionData), "GetWantBlocking")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", nameof(StarfieldRecords.UnknownConditionData), "Unknown")]
    public void TheFunctionRow_IsTheDiscriminatorChoosingTheKind_EachReadAsItsFunctionsName(GameRelease release, string table, string column, string leaf, string label)
    {
        var function = Data(release, table, column).Fields.Require().Single(f => f.IsDiscriminator);

        Assert.Equal("Function", function.DisplayLabel);
        Assert.Equal(label, function.EnumMembers.Single(m => m.Value == leaf).Label);
    }

    [Theory]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions")]
    public void GetEventDatasOwnFunction_IsItsEventFunction_NotMutagensUnheldFunction(GameRelease release, string table, string column)
    {
        var function = Member(Data(release, table, column), "Function").Variants.Require();

        Assert.Equal(["GetIsID", "IsInList", "GetValue", "HasKeyword", "GetItemValue"], function["GetEventDataConditionData"].EnumMembers.Select(m => m.Value));
    }

    [Theory]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", "FirstUnusedIntParameter")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", "FirstUnusedStringParameter")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", "SecondUnusedIntParameter")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", "SecondUnusedStringParameter")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", "Unused")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", "FirstUnusedIntParameter")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", "FirstUnusedStringParameter")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", "SecondUnusedIntParameter")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", "SecondUnusedStringParameter")]
    public void ASlotMutagenNamesUnused_IsNoMember(GameRelease release, string table, string column, string carrier)
    {
        Assert.DoesNotContain(carrier, Data(release, table, column).Fields.Require().Select(f => f.Name));
    }

    [Fact]
    public void ASkyrimConditionsFunctionMember_VariesForTheEventAndUnknownLeavesAlone()
    {
        Assert.Equal(
            [nameof(SkyrimRecords.GetEventDataConditionData), nameof(SkyrimRecords.UnknownConditionData)],
            Member(SkyrimData(), "Function").Variants.Require().Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void TheConditionItself_KeepsAKindRow()
    {
        var kind = SchemaFields.At(GameRelease.SkyrimSE, "perk", "Conditions.[]").Fields.Require().Single(f => f.IsDiscriminator);

        Assert.Equal("Kind", kind.DisplayLabel);
    }

    [Fact]
    public void AParameterTheFunctionUses_IsAMemberOfThatFunctionAlone()
    {
        var actorValue = Member(SkyrimData(), "ActorValue").Variants.Require();

        Assert.Contains(nameof(SkyrimRecords.GetActorValueConditionData), actorValue.Keys);
        Assert.DoesNotContain(nameof(SkyrimRecords.GetIsIDConditionData), actorValue.Keys);
    }

    [Theory]
    [InlineData(nameof(SkyrimRecords.IsLinkedToConditionData), "Target", "Keyword")]
    [InlineData(nameof(SkyrimRecords.GetInCellParamConditionData), "Cell", "Target")]
    [InlineData(nameof(SkyrimRecords.SpellHasKeywordConditionData), "SpellSource", "Keyword")]
    public void AFunctionsParameters_KeepItsOwnOrder(string function, string first, string second)
    {
        var own = SkyrimData().Fields.Require().Where(f => f.Variants?.ContainsKey(function) == true).Select(f => f.Name).ToList();

        Assert.Equal([first, second], own);
    }

    [Fact]
    public void AFormParameterHeldAsALinkOrAnIndex_IsAReferenceToTheRecordsTheFunctionTakes()
    {
        var target = Member(SkyrimData(), "Quest").Variants.Require()[nameof(SkyrimRecords.GetStageConditionData)];

        Assert.Equal("formKey", target.Type);
        Assert.Equal(["qust"], target.ValidFormKeyTypes);
        Assert.Equal(["UseAliases", "UsePackageData"], target.IndexWhen);
    }

    [Theory]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", "Quest", "UseAliases")]
    [InlineData(GameRelease.SkyrimSE, "perk", "Conditions", "Quest", "UsePackageData")]
    [InlineData(GameRelease.Starfield, "qust", "DialogConditions", "FirstParameter", "UseAliases")]
    public void AFormParameter_IsAnIndex_WhileItsConditionSaysItNamesAnAliasOrPackageData(GameRelease release, string table, string column, string parameter, string flag)
    {
        using var owner = JsonDocument.Parse($$"""{"MutagenObjectType":"GetStageConditionData","{{flag}}":true}""");

        var shape = DocumentNodes.VariantFor(Member(Data(release, table, column), parameter), owner.RootElement);

        Assert.Equal("int", shape.Type);
        Assert.Empty(shape.ValidFormKeyTypes);
    }

    [Fact]
    public void AStarfieldFormParameter_IsAReferenceToTheRecordsTheFunctionTakes()
    {
        Assert.Equal(["qust"], Member(StarfieldData(), "FirstParameter").Variants.Require()[nameof(StarfieldRecords.GetStageConditionData)].ValidFormKeyTypes);
    }

    [Theory]
    [InlineData(nameof(StarfieldRecords.GetWantBlockingConditionData), "FirstParameter")]
    [InlineData(nameof(StarfieldRecords.GetWantBlockingConditionData), "SecondParameter")]
    [InlineData(nameof(StarfieldRecords.GetStageConditionData), "SecondParameter")]
    public void AnIntegerSlotTheFunctionLeavesUnused_IsNoRowOfThatFunction(string function, string slot)
    {
        Assert.DoesNotContain(function, Member(StarfieldData(), slot).Variants.Require().Keys);
    }

    [Theory]
    [InlineData(nameof(StarfieldRecords.GetVATSValueConditionData), "FirstParameter")]
    [InlineData(nameof(StarfieldRecords.GetVATSValueConditionData), "SecondParameter")]
    [InlineData(nameof(StarfieldRecords.GetStageDoneConditionData), "SecondParameter")]
    public void AnIntegerSlotTheFunctionReads_IsARowOfThatFunction(string function, string slot)
    {
        Assert.Equal("int", Member(StarfieldData(), slot).Variants.Require()[function].Type);
    }
}
