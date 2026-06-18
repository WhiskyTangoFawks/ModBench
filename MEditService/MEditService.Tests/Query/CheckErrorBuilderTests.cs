using System.Text.Json;
using MEditService.Core.Queries;

namespace MEditService.Tests.Query;

public class CheckErrorBuilderTests
{
    private static JsonElement J(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static readonly FieldMetadata FormKeyMeta = new(
        "race", "formKey", false, ["race"], [], AllowsNull: false);

    [Fact]
    public void Build_CleanScalarReference_ReturnsNull()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, "000001:Test.esp", _ => "race");
        Assert.Null(err);
    }

    [Fact]
    public void Build_NullScalarReference_NonNullableField_ReturnsNullNotAllowedMessage()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, null, _ => "race");
        Assert.Equal("Found a NULL reference, expected: race", err);
    }

    [Fact]
    public void Build_NullScalarReference_NullableField_ReturnsNull()
    {
        var meta = FormKeyMeta with { AllowsNull = true };
        var err = CheckErrorBuilder.Build(meta, null, _ => "race");
        Assert.Null(err);
    }

    [Fact]
    public void Build_DanglingScalarReference_ReturnsUnresolvedMessage()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, "000FFF:Test.esp", _ => null);
        Assert.Equal("[000FFF:Test.esp] <Error: Could not be resolved>", err);
    }

    [Fact]
    public void Build_TypeMismatchedScalarReference_ReturnsMismatchMessage()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, "000001:Test.esp", _ => "npc_");
        Assert.Equal("Found a npc_ reference, expected: race", err);
    }

    [Fact]
    public void Build_ArrayOfFormKey_PerElementErrors_JoinedWithSemicolon()
    {
        var elemMeta = new FieldMetadata("", "formKey", false, ["kywd"], [], AllowsNull: true);
        var meta = new FieldMetadata("keywords", "array", true, [], [], ElementType: elemMeta);
        var value = J("""["000001:Test.esp", null, "000FFF:Test.esp"]""");

        var err = CheckErrorBuilder.Build(meta, value, fk => fk == "000001:Test.esp" ? "kywd" : null);

        Assert.Equal("[2]: [000FFF:Test.esp] <Error: Could not be resolved>", err);
    }

    [Fact]
    public void Build_StructArray_FormKeySubField_ErrorIncludesIndexAndFieldName()
    {
        var factionField = new FieldMetadata("faction", "formKey", false, ["fact"], [], AllowsNull: false);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [factionField]);
        var meta = new FieldMetadata("factions", "array", true, [], [], ElementType: elemMeta);
        var value = J("""[{"faction": null, "rank": 0}]""");

        var err = CheckErrorBuilder.Build(meta, value, _ => null);

        Assert.Equal("[0].faction: Found a NULL reference, expected: fact", err);
    }

    [Fact]
    public void Build_NonFormKeyField_ReturnsNull()
    {
        var meta = new FieldMetadata("height", "float", false, [], []);
        var err = CheckErrorBuilder.Build(meta, 1.5, _ => null);
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

        var err = CheckErrorBuilder.Build(meta, value, _ => null);

        Assert.Equal("[0].inner.target: Found a NULL reference, expected: kywd", err);
    }
}
