using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Tests.Schema;

public sealed class UnionMechanismSchemaTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static IEnumerable<string> Domain(FieldMetadata meta) => meta.EnumMembers.Select(m => m.Value);

    private static IReadOnlyDictionary<string, FieldMetadata> RequireVariants(FieldMetadata meta) =>
        meta.Variants ?? throw new InvalidOperationException($"Expected '{meta.Name}' to have variants.");

    [Theory]
    [InlineData("gmst")]
    [InlineData("glob")]
    [InlineData("dmgt")]
    [InlineData("omod")]
    public void ATableOfSeveralRecordClasses_IsOneSparseUnionKeyedByTheDocumentsDiscriminator(string table) =>
        AssertOneSparseUnion([.. Schemas[table].RecordColumns.Select(c => c.Field)]);

    [Theory]
    [InlineData("omod", "Properties.[]")]
    [InlineData("cobj", "Conditions.[]")]
    [InlineData("cobj", "Conditions.[].Data")]
    [InlineData("npc_", "VirtualMachineAdapter.Scripts.[].Properties.[]")]
    [InlineData("npc_", "Level")]
    [InlineData("qust", "Aliases.[]")]
    public void AMemberWhoseBaseHasLeaves_IsOneSparseUnionKeyedByTheDocumentsDiscriminator(string table, string path) =>
        AssertOneSparseUnion(SchemaFields.At(GameRelease.Fallout4, table, path).Fields.Require());

    private static void AssertOneSparseUnion(IReadOnlyList<FieldMetadata> fields)
    {
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
            var variants = RequireVariants(field);
            Assert.All(variants.Keys, leaf => Assert.Contains(leaf, domain));
            var first = variants.Values.First();
            Assert.Equal((first.Type, first.IsArray, first.LeafTypeName, first.ElementType?.Type), (field.Type, field.IsArray, field.LeafTypeName, field.ElementType?.Type));
        });
    }

    [Fact]
    public void GameSettingData_IsOneScalarWithAVariantPerRecordClass_NotAWidenedText()
    {
        var data = SchemaFields.At(GameRelease.Fallout4, "gmst", "Data");
        var variants = RequireVariants(data);

        Assert.Equal(
            new Dictionary<string, string>
            {
                [nameof(GameSettingFloat)] = "float",
                [nameof(GameSettingInt)] = "int",
                [nameof(GameSettingUInt)] = "int",
                [nameof(GameSettingString)] = "translatedString",
                [nameof(GameSettingBool)] = "bool",
            },
            variants.ToDictionary(v => v.Key, v => v.Value.Type));
        Assert.Contains(data.Type, variants.Values.Select(v => v.Type));
        Assert.NotEqual("string", data.Type);
    }

    [Fact]
    public void AColumnVaryingByRecordClass_IsAbsentNull_BecauseGlobOutputCharIsDeclaredByGlobalFloatAloneSoPuttingFalseBackWouldAnswerItForAGlobalIntRowWithNoSuchMember()
    {
        var outputChar = Schemas["glob"].RecordColumns.Single(c => c.Name == "OutputChar");

        Assert.NotNull(outputChar.Field.Variants);
        Assert.True(outputChar.AbsentIsNull);
    }

    [Fact]
    public void PerkEffectModification_AdvertisesEachLeafsOwnEnumDomain()
    {
        var modification = SchemaFields.At(GameRelease.Fallout4, "perk", "Effects.[].Modification");
        var variants = RequireVariants(modification);

        Assert.Equal(["Set", "Add", "Multiply"], Domain(variants[nameof(PerkEntryPointModifyValue)]));
        Assert.Equal(
            ["AddAVMult", "SetToAVMult", "MultiplyAVMult", "MultiplyOnePlusAVMult"],
            Domain(variants[nameof(PerkEntryPointModifyActorValue)]));
    }

    [Fact]
    public void ObjectModPropertyFunctionType_AdvertisesEachLeafsOwnEnumDomain()
    {
        var functionType = SchemaFields.At(GameRelease.Fallout4, "omod", "Properties.[].FunctionType");
        var variants = RequireVariants(functionType);

        Assert.Equal(["Set", "MultAndAdd", "Add"], Domain(variants["ObjectModFloatProperty<Armor+Property>"]));
        Assert.Equal(["Set", "And", "Or"], Domain(variants["ObjectModBoolProperty<Armor+Property>"]));
        Assert.Equal(["Set", "Remove", "Add"], Domain(variants["ObjectModFormLinkIntProperty<Armor+Property>"]));
    }
}
