using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public sealed class ColorAlphaConflictTests
{
    private static FieldMetadata Column(string table, string column) =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.Single(c => c.Name == column).ToFieldMetadata();

    private static ConflictThis OverrideState(FieldMetadata meta, string? masterValue, string overrideValue)
    {
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(meta, masterValue is null ? null : JsonSerializer.Deserialize<JsonElement>(masterValue))], "Data");
        var edited = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null, [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>(overrideValue))], "Data");

        return Assert.Single(CompareQuery.Classify([master, edited]).Diffs).CellStates["B.esp"];
    }

    [Theory]
    [InlineData("\"#00102030\"", "\"#102030\"")]
    [InlineData("\"#00102030\"", "\"#7F102030\"")]
    public void AColorHoldingNoAlpha_ThatDiffersOnlyInTheAlphaItsDocumentCarries_IsIdenticalToMaster(string master, string edited)
    {
        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(Column("wthr", "LightningColor"), master, edited));
    }

    [Fact]
    public void AColorHoldingNoAlpha_AbsentAgainstItsDefaultsRgbSpelledWithoutAlpha_IsIdenticalToMaster()
    {
        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(Column("wthr", "LightningColor"), null, "\"#000000\""));
    }

    [Fact]
    public void AColorHoldingNoAlpha_ThatDiffersInItsRgb_Overrides()
    {
        Assert.Equal(ConflictThis.Override, OverrideState(Column("wthr", "LightningColor"), "\"#00102030\"", "\"#00102031\""));
    }

    [Fact]
    public void AColorHoldingAlpha_ThatDiffersInItsAlpha_Overrides()
    {
        Assert.Equal(ConflictThis.Override, OverrideState(Column("kywd", "Color"), "\"#00102030\"", "\"#7F102030\""));
    }

    [Fact]
    public void AColorHoldingAlpha_SpelledWithAndWithoutAnOpaqueAlpha_IsIdenticalToMaster()
    {
        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(Column("kywd", "Color"), "\"#FF102030\"", "\"#102030\""));
    }

    [Fact]
    public void AStructHoldingAColorWithNoAlpha_ThatDiffersOnlyInThatAlpha_IsIdenticalToMaster()
    {
        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(
            Column("refr", "Primitive"), """{"Color":"#00102030"}""", """{"Color":"#102030"}"""));
    }

    [Fact]
    public void AColorHoldingNoAlphaOnlyUnderTheUnionLeafItsStructNames_ThatDiffersOnlyInThatAlpha_IsIdenticalToMaster()
    {
        var tint = new FieldMetadata("Tint", ColorReading.ApiType, false, [], [], HoldsAlpha: true);
        var union = new FieldMetadata("Data", "struct", false, [], [], Fields:
        [
            new FieldMetadata(LoquiUnions.UnionTypeDiscriminator, "enum", false, [], [new EnumMember("WithAlpha"), new EnumMember("WithoutAlpha")], IsDiscriminator: true),
            tint with { Variants = new Dictionary<string, FieldMetadata> { ["WithoutAlpha"] = tint with { HoldsAlpha = false } } },
        ]);

        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(union,
            """{"MutagenObjectType":"WithoutAlpha","Tint":"#00102030"}""", """{"MutagenObjectType":"WithoutAlpha","Tint":"#102030"}"""));
    }
}
