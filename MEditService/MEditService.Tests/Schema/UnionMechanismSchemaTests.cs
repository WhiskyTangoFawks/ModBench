using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Schema;

/// <summary>Record classes sharing a signature, OMOD's generic-closed properties, abstract and
/// concrete unions: every base with leaves is one sparse union, the document's discriminator
/// beside members carrying a variant per leaf wherever leaves differ (ADR-0005).</summary>
public sealed class UnionMechanismSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static FieldMetadata At(string table, params string[] hops)
    {
        var meta = Schemas[table].RecordColumns.Single(c => c.Name == hops[0]).ToFieldMetadata();
        foreach (var hop in hops.Skip(1)) meta = hop == "[]" ? meta.ElementType! : meta.Fields!.Single(f => f.Name == hop);
        return meta;
    }

    private static IEnumerable<string> Domain(FieldMetadata meta) => meta.EnumMembers.Select(m => m.Value);

    [Theory]
    [InlineData("gmst")]
    [InlineData("glob")]
    [InlineData("dmgt")]
    [InlineData("omod")]
    [InlineData("omod", "Properties", "[]")]
    [InlineData("cobj", "Conditions", "[]")]
    [InlineData("cobj", "Conditions", "[]", "Data")]
    [InlineData("npc_", "VirtualMachineAdapter", "Scripts", "[]", "Properties", "[]")]
    public void EveryBaseWithLeaves_IsOneSparseUnionKeyedByTheDocumentsDiscriminator(string table, params string[] hops)
    {
        var fields = hops.Length == 0
            ? Schemas[table].RecordColumns.Select(c => c.ToFieldMetadata()).ToList()
            : At(table, hops).Fields!;

        var discriminator = Assert.Single(fields, f => f.IsDiscriminator);
        Assert.Equal("MutagenObjectType", discriminator.Name);
        Assert.Equal("enum", discriminator.Type);
        Assert.Equal("Kind", discriminator.DisplayLabel);
        var domain = Domain(discriminator).ToList();
        Assert.True(domain.Count > 1, "a union has more than one leaf");
        Assert.Equal(domain.Count, discriminator.EnumMembers.Select(m => m.Label).Distinct(StringComparer.Ordinal).Count());
        Assert.All(discriminator.EnumMembers, m => Assert.False(string.IsNullOrWhiteSpace(m.Label)));

        var varying = fields.Where(f => f.Variants != null).ToList();
        Assert.NotEmpty(varying);
        Assert.All(varying, field =>
        {
            Assert.True(field.AllowsNull, $"{field.Name}: a member some leaf lacks or shapes differently reads as absent through the others");
            Assert.All(field.Variants!.Keys, leaf => Assert.Contains(leaf, domain));
            var first = field.Variants!.Values.First();
            Assert.Equal((first.Type, first.IsArray, first.LeafTypeName, first.ElementType?.Type), (field.Type, field.IsArray, field.LeafTypeName, field.ElementType?.Type));
        });
    }

    [Fact]
    public void GameSettingData_IsOneScalarWithAVariantPerRecordClass_NotAWidenedText()
    {
        var data = At("gmst", "Data");

        Assert.Equal(
            new Dictionary<string, string>
            {
                [nameof(GameSettingFloat)] = "float",
                [nameof(GameSettingInt)] = "int",
                [nameof(GameSettingUInt)] = "int",
                [nameof(GameSettingString)] = "translatedString",
                [nameof(GameSettingBool)] = "bool",
            },
            data.Variants!.ToDictionary(v => v.Key, v => v.Value.Type));
        Assert.Contains(data.Type, data.Variants!.Values.Select(v => v.Type));
        Assert.NotEqual("string", data.Type);
    }

    // glob.OutputChar is declared by GlobalFloat alone, so "false" is that class's default and no
    // other's: a view putting it back would answer it for a GlobalInt row that has no such member.
    [Fact]
    public void AColumnVaryingByRecordClass_CoalescesToNoLiteral()
    {
        var outputChar = Schemas["glob"].RecordColumns.Single(c => c.Name == "OutputChar");

        Assert.NotNull(outputChar.Field.Variants);
        Assert.True(outputChar.IsViewable, "the leaves agree on its type, so the view keeps the column");
        Assert.Null(outputChar.ViewDefaultLiteral);
    }

    [Fact]
    public void PerkEffectModification_AdvertisesEachLeafsOwnEnumDomain()
    {
        var modification = At("perk", "Effects", "[]", "Modification");

        Assert.Equal(["Set", "Add", "Multiply"], Domain(modification.Variants![nameof(PerkEntryPointModifyValue)]));
        Assert.Equal(
            ["AddAVMult", "SetToAVMult", "MultiplyAVMult", "MultiplyOnePlusAVMult"],
            Domain(modification.Variants[nameof(PerkEntryPointModifyActorValue)]));
    }

    [Fact]
    public void ObjectModPropertyFunctionType_AdvertisesEachLeafsOwnEnumDomain()
    {
        var functionType = At("omod", "Properties", "[]", "FunctionType");

        Assert.Equal(["Set", "MultAndAdd", "Add"], Domain(functionType.Variants!["ObjectModFloatProperty<Armor+Property>"]));
        Assert.Equal(["Set", "And", "Or"], Domain(functionType.Variants["ObjectModBoolProperty<Armor+Property>"]));
        Assert.Equal(["Set", "Remove", "Add"], Domain(functionType.Variants["ObjectModFormLinkIntProperty<Armor+Property>"]));
    }
}
