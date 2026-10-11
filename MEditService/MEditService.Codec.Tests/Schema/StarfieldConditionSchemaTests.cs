using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Starfield;

namespace MEditService.Codec.Tests.Schema;

public sealed class StarfieldConditionSchemaTests
{
    private static FieldMetadata Data() =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield)["qust"].RecordColumns.Single(c => c.Name == "DialogConditions")
            .Field.ElementType.Require().Fields.Require().Single(f => f.Name == "Data");

    private static FieldMetadata Member(FieldMetadata owner, string name) => owner.Fields.Require().Single(f => f.Name == name);

    private static FieldMetadata Function() => Data().Fields.Require().Single(f => f.IsDiscriminator);

    [Fact]
    public void GetEventDatasOwnFunction_IsItsEventFunction_NotMutagensUnheldFunction()
    {
        var function = Member(Data(), "Function").Variants.Require();

        Assert.Equal(
            Enum.GetNames<GetEventDataConditionData.EventFunction>(),
            function[nameof(GetEventDataConditionData)].EnumMembers.Select(m => m.Value));
    }

    [Theory]
    [InlineData(nameof(GetIsIDConditionData), "GetIsID")]
    [InlineData(nameof(GetWantBlockingConditionData), "GetWantBlocking")]
    [InlineData(nameof(UnknownConditionData), "Unknown")]
    public void TheFunctionRow_ChoosesTheKind_EachReadAsItsFunctionsName(string leaf, string label)
    {
        var function = Function();

        Assert.Equal("Function", function.DisplayLabel);
        Assert.Equal(label, function.EnumMembers.Single(m => m.Value == leaf).Label);
    }

    [Theory]
    [InlineData("FirstUnusedStringParameter")]
    [InlineData("SecondUnusedStringParameter")]
    [InlineData("FirstUnusedIntParameter")]
    [InlineData("SecondUnusedIntParameter")]
    public void ASlotMutagenNamesUnused_IsNoMember(string carrier)
    {
        Assert.DoesNotContain(carrier, Data().Fields.Require().Select(f => f.Name));
    }

    [Theory]
    [InlineData(nameof(GetWantBlockingConditionData), "FirstParameter")]
    [InlineData(nameof(GetWantBlockingConditionData), "SecondParameter")]
    [InlineData(nameof(GetStageConditionData), "SecondParameter")]
    public void AnIntegerSlotTheFunctionLeavesUnused_IsNoRowOfThatFunction(string function, string slot)
    {
        Assert.DoesNotContain(function, Member(Data(), slot).Variants.Require().Keys);
    }

    [Theory]
    [InlineData(nameof(GetVATSValueConditionData), "FirstParameter")]
    [InlineData(nameof(GetVATSValueConditionData), "SecondParameter")]
    [InlineData(nameof(GetStageDoneConditionData), "SecondParameter")]
    public void AnIntegerSlotTheFunctionReads_IsARowOfThatFunction(string function, string slot)
    {
        Assert.Equal("int", Member(Data(), slot).Variants.Require()[function].Type);
    }

    [Fact]
    public void AFormParameter_IsAReference_OrAnIndexWhileItsConditionSaysItNamesAnAlias()
    {
        var quest = Member(Data(), "FirstParameter");
        using var aliased = JsonDocument.Parse($$"""{"MutagenObjectType":"{{nameof(GetStageConditionData)}}","UseAliases":true}""");

        Assert.Equal(["qust"], quest.Variants.Require()[nameof(GetStageConditionData)].ValidFormKeyTypes);
        Assert.Equal("int", DocumentNodes.VariantFor(quest, aliased.RootElement).Type);
    }
}
