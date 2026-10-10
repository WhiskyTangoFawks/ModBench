using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Skyrim;

namespace MEditService.Codec.Tests.Schema;

public sealed class SkyrimConditionSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE);

    private static FieldMetadata Data() =>
        Member(Schemas["perk"].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementType.Require(), "Data");

    private static FieldMetadata Member(FieldMetadata owner, string name) => owner.Fields.Require().Single(f => f.Name == name);

    private static FieldMetadata Function() => Data().Fields.Require().Single(f => f.IsDiscriminator);

    [Fact]
    public void TheFunctionRow_IsTheDiscriminatorOverOneKindPerFunction()
    {
        var function = Function();

        Assert.Equal("Function", function.DisplayLabel);
        Assert.Contains(nameof(GetIsIDConditionData), function.EnumMembers.Select(m => m.Value));
    }

    [Theory]
    [InlineData(nameof(GetIsIDConditionData), "GetIsID")]
    [InlineData(nameof(EPMagic_SpellHasKeywordConditionData), "EPMagic_SpellHasKeyword")]
    [InlineData(nameof(GetVATSValueWeaponConditionData), "GetVATSValueWeapon")]
    [InlineData(nameof(UnknownConditionData), "Unknown")]
    public void EachFunction_ReadsAsItsName(string leaf, string label)
    {
        Assert.Equal(label, Function().EnumMembers.Single(m => m.Value == leaf).Label);
    }

    [Fact]
    public void TheConditionItself_KeepsAKindRow()
    {
        var kind = Schemas["perk"].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementType.Require()
            .Fields.Require().Single(f => f.IsDiscriminator);

        Assert.Equal("Kind", kind.DisplayLabel);
    }

    [Fact]
    public void GetEventDatasOwnFunction_IsItsEventFunction()
    {
        var function = Member(Data(), "Function").Variants.Require();

        Assert.Equal(
            Enum.GetNames<GetEventDataConditionData.EventFunction>(),
            function[nameof(GetEventDataConditionData)].EnumMembers.Select(m => m.Value));
        Assert.Equal([nameof(GetEventDataConditionData), nameof(UnknownConditionData)], function.Keys.Order(StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("FirstUnusedIntParameter")]
    [InlineData("FirstUnusedStringParameter")]
    [InlineData("SecondUnusedIntParameter")]
    [InlineData("SecondUnusedStringParameter")]
    [InlineData("Unused")]
    public void AParameterSlotTheFunctionLeavesUnused_IsNoMember(string carrier)
    {
        Assert.DoesNotContain(carrier, Data().Fields.Require().Select(f => f.Name));
    }

    [Fact]
    public void AParameterTheFunctionUses_IsAMemberOfThatFunctionAlone()
    {
        var actorValue = Member(Data(), "ActorValue").Variants.Require();

        Assert.Contains(nameof(GetActorValueConditionData), actorValue.Keys);
        Assert.DoesNotContain(nameof(GetIsIDConditionData), actorValue.Keys);
    }

    [Fact]
    public void RunOn_NamesTheReferenceMemberUnderExactlyTheReferenceValue()
    {
        var runOn = Member(Data(), "RunOnType");
        var siblingsInUse = runOn.SiblingsInUse.Require();

        Assert.Equal(runOn.EnumMembers.Select(m => m.Value).Order(StringComparer.Ordinal), siblingsInUse.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(["Reference"], siblingsInUse[nameof(Condition.RunOnType.Reference)]);
        Assert.All(siblingsInUse.Where(kv => kv.Key != nameof(Condition.RunOnType.Reference)), kv => Assert.Empty(kv.Value));
    }

    [Fact]
    public void AFormParameterHeldAsALinkOrAnIndex_IsAReferenceToTheRecordsTheFunctionTakes()
    {
        var target = Member(Data(), "Quest").Variants.Require()[nameof(GetStageConditionData)];

        Assert.Equal("formKey", target.Type);
        Assert.Equal(["qust"], target.ValidFormKeyTypes);
        Assert.Equal(["UseAliases", "UsePackageData"], target.IndexWhen);
    }

    [Theory]
    [InlineData("UseAliases")]
    [InlineData("UsePackageData")]
    public void AFormParameter_IsAnIndex_WhileItsConditionSaysItNamesAnAliasOrPackageData(string flag)
    {
        using var owner = JsonDocument.Parse($$"""{"MutagenObjectType":"{{nameof(GetStageConditionData)}}","{{flag}}":true}""");

        var shape = DocumentNodes.VariantFor(Member(Data(), "Quest"), owner.RootElement);

        Assert.Equal("int", shape.Type);
        Assert.Empty(shape.ValidFormKeyTypes);
    }
}
