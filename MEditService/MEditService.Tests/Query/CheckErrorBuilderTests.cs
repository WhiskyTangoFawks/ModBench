using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

public class CheckErrorBuilderTests
{
    private static JsonElement J(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static readonly FieldMetadata FormKeyMeta = new(
        "race", "formKey", false, ["race"], [], AllowsNull: false);

    private static RecordLookupEntry? Entry(string recordType) => new RecordLookupEntry(recordType, null);

    [Fact]
    public void Build_CleanScalarReference_ReturnsNull()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, "000001:Test.esp", _ => Entry("race"), GameRelease.Fallout4);
        Assert.Null(err);
    }

    [Fact]
    public void Build_NullScalarReference_NonNullableField_ReturnsNullNotAllowedMessage()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, null, _ => Entry("race"), GameRelease.Fallout4);
        Assert.Equal("Found a NULL reference, expected: race", err);
    }

    [Fact]
    public void Build_NullScalarReference_NullableField_ReturnsNull()
    {
        var meta = FormKeyMeta with { AllowsNull = true };
        var err = CheckErrorBuilder.Build(meta, null, _ => Entry("race"), GameRelease.Fallout4);
        Assert.Null(err);
    }

    [Fact]
    public void Build_DanglingScalarReference_ReturnsUnresolvedMessage()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, "000FFF:Test.esp", _ => null, GameRelease.Fallout4);
        Assert.Equal("[000FFF:Test.esp] <Error: Could not be resolved>", err);
    }

    [Fact]
    public void Build_TypeMismatchedScalarReference_ReturnsMismatchMessage()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, "000001:Test.esp", _ => Entry("npc_"), GameRelease.Fallout4);
        Assert.Equal("Found a npc_ reference, expected: race", err);
    }

    [Fact]
    public void Build_ArrayOfFormKey_PerElementErrors_JoinedWithSemicolon()
    {
        var elemMeta = new FieldMetadata("", "formKey", false, ["kywd"], [], AllowsNull: true);
        var meta = new FieldMetadata("keywords", "array", true, [], [], ElementType: elemMeta);
        var value = J("""["000001:Test.esp", null, "000FFF:Test.esp"]""");

        var err = CheckErrorBuilder.Build(meta, value, fk => fk == "000001:Test.esp" ? Entry("kywd") : null, GameRelease.Fallout4);

        Assert.Equal("[2]: [000FFF:Test.esp] <Error: Could not be resolved>", err);
    }

    [Fact]
    public void Build_StructArray_FormKeySubField_ErrorIncludesIndexAndFieldName()
    {
        var factionField = new FieldMetadata("faction", "formKey", false, ["fact"], [], AllowsNull: false);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [factionField]);
        var meta = new FieldMetadata("factions", "array", true, [], [], ElementType: elemMeta);
        var value = J("""[{"faction": null, "rank": 0}]""");

        var err = CheckErrorBuilder.Build(meta, value, _ => null, GameRelease.Fallout4);

        Assert.Equal("[0].faction: Found a NULL reference, expected: fact", err);
    }

    [Fact]
    public void Build_EmptyValidTypes_AnyResolvedTypeAccepted()
    {
        // validTypes.Count > 0 guard: when validTypes is empty, no type_mismatch check runs.
        var meta = new FieldMetadata("link", "formKey", false, [], [], AllowsNull: false);
        var err = CheckErrorBuilder.Build(meta, "000001:Test.esp", _ => Entry("npc_"), GameRelease.Fallout4);
        Assert.Null(err);
    }

    [Fact]
    public void Build_NonFormKeyField_ReturnsNull()
    {
        var meta = new FieldMetadata("height", "float", false, [], []);
        var err = CheckErrorBuilder.Build(meta, 1.5, _ => null, GameRelease.Fallout4);
        Assert.Null(err);
    }

    [Fact]
    public void Build_NestedStructInsideArrayStruct_FormKeyReached()
    {
        var innerFk = new FieldMetadata("target", "formKey", false, ["kywd"], [], AllowsNull: false);
        var innerStruct = new FieldMetadata("inner", "struct", false, [], [], Fields: [innerFk]);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [innerStruct]);
        var meta = new FieldMetadata("links", "array", true, [], [], ElementType: elemMeta);
        var value = J("""[{"inner":{"target":null}}]""");

        var err = CheckErrorBuilder.Build(meta, value, _ => null, GameRelease.Fallout4);

        Assert.Equal("[0].inner.target: Found a NULL reference, expected: kywd", err);
    }

    // #613: the Player and friends (00000007 and below the high-range boundary, in the game's
    // implicitly-always-loaded master) never carry a CheckError — a lookup miss on them can't mean
    // a broken link, since form_lookup was never going to contain them (see FormKeyResolution.From).
    [Fact]
    public void Build_HardcodedFormKeyMissingFromLookup_ReturnsNull()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, "000007:Fallout4.esm", _ => null, GameRelease.Fallout4);
        Assert.Null(err);
    }
}
