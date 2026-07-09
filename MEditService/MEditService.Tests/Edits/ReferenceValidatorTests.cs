using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Schema;

namespace MEditService.Tests.Edits;

public class ReferenceValidatorTests
{
    private static ColumnSpec FormKeyCol(string name, string[] validTypes, bool allowsNull = false) =>
        new(name, name, "VARCHAR", _ => null, "formKey", validTypes, [], null, AllowsNull: allowsNull);

    private static ColumnSpec ArrayFormKeyCol(string name, string[] validTypes, bool allowsNull = false) =>
        new(name, name, "JSON", _ => null, "array", [], [], null,
            IsArray: true,
            ElementType: new FieldMetadata("", "formKey", false, validTypes, [], AllowsNull: allowsNull));

    private static ColumnSpec ArrayStructCol(string name, FieldMetadata elemMeta) =>
        new(name, name, "JSON", _ => null, "array", [], [], null,
            IsArray: true, ElementType: elemMeta);

    private static List<ReferenceValidationError> Validate(ColumnSpec col, object? value,
        Func<string, string?>? getRecordType = null) =>
        ReferenceValidator.Validate(col, _ => value, getRecordType ?? (_ => "kywd"));

    // --- Scalar formKey ---

    [Fact]
    public void Validate_ScalarFormKey_Clean_ReturnsNoErrors()
    {
        var col = FormKeyCol("race", ["race"]);
        var errors = Validate(col, "000001:Test.esp", _ => "race");
        Assert.Empty(errors);
    }

    [Fact]
    public void Validate_ScalarFormKey_Null_NonNullable_ReturnsNullNotAllowed()
    {
        var col = FormKeyCol("race", ["race"], allowsNull: false);
        var errors = Validate(col, (string?)null, _ => null);
        Assert.Single(errors);
        Assert.Equal("race", errors[0].FieldPath);
        Assert.Equal("null_not_allowed", errors[0].Reason);
    }

    [Fact]
    public void Validate_ScalarFormKey_Null_Nullable_ReturnsNoErrors()
    {
        var col = FormKeyCol("race", ["race"], allowsNull: true);
        Assert.Empty(Validate(col, (string?)null));
    }

    [Fact]
    public void Validate_ScalarFormKey_NotInSession_ReturnsNotInSession()
    {
        var col = FormKeyCol("race", ["race"]);
        var errors = Validate(col, "000FFF:Test.esp", _ => null);
        Assert.Single(errors);
        Assert.Equal("not_in_session", errors[0].Reason);
    }

    [Fact]
    public void Validate_ScalarFormKey_TypeMismatch_ReturnsTypeMismatch()
    {
        var col = FormKeyCol("race", ["race"]);
        var errors = Validate(col, "000001:Test.esp", _ => "npc_");
        Assert.Single(errors);
        Assert.Equal("type_mismatch", errors[0].Reason);
        Assert.Equal(["race"], errors[0].ExpectedTypes);
    }

    // --- Array of formKey ---

    [Fact]
    public void Validate_ArrayFormKey_DanglingElement_ReturnsIndexedPath()
    {
        var col = ArrayFormKeyCol("keywords", ["kywd"], allowsNull: true);
        var json = JsonDocument.Parse("""["000001:Test.esp","000FFF:Test.esp"]""").RootElement.Clone();
        var errors = Validate(col, json, fk => fk == "000001:Test.esp" ? "kywd" : null);
        Assert.Single(errors);
        Assert.Equal("keywords[1]", errors[0].FieldPath);
        Assert.Equal("not_in_session", errors[0].Reason);
    }

    // --- Array of struct with formKey sub-field ---

    [Fact]
    public void Validate_ArrayStruct_FormKeySubField_ReturnsIndexedDotPath()
    {
        var factionField = new FieldMetadata("faction", "formKey", false, ["fact"], [], AllowsNull: false);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [factionField]);
        var col = ArrayStructCol("factions", elemMeta);
        var json = JsonDocument.Parse("""[{"faction":null,"rank":0}]""").RootElement.Clone();

        var errors = Validate(col, json, _ => null);

        Assert.Single(errors);
        Assert.Equal("factions[0].faction", errors[0].FieldPath);
        Assert.Equal("null_not_allowed", errors[0].Reason);
    }

    [Fact]
    public void Validate_ScalarFormKey_EmptyString_NonNullable_ErrorValueIsEmptyNotNullLiteral()
    {
        // value ?? "Null" must preserve the actual value ("") not always substitute "Null".
        var col = FormKeyCol("race", ["race"], allowsNull: false);
        var errors = Validate(col, "", _ => null);
        Assert.Single(errors);
        Assert.Equal("null_not_allowed", errors[0].Reason);
        Assert.Equal("", errors[0].Value);
    }

    [Fact]
    public void Validate_ScalarFormKey_EmptyValidTypes_AnyResolvedTypeAccepted()
    {
        // validTypes.Count > 0 guard: when validTypes is empty, no type_mismatch check runs.
        var col = FormKeyCol("link", [], allowsNull: false);
        var errors = Validate(col, "000001:Test.esp", _ => "npc_");
        Assert.Empty(errors);
    }

    // --- Depth-2: struct sub-field that is itself a struct containing a formKey ---

    [Fact]
    public void Validate_NestedStructSubField_NullFormKey_ReturnsError()
    {
        var innerFk = new FieldMetadata("target", "formKey", false, ["kywd"], [], AllowsNull: false);
        var innerStruct = new FieldMetadata("inner", "struct", false, [], [], Fields: [innerFk]);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [innerStruct]);
        var col = ArrayStructCol("links", elemMeta);

        var json = JsonDocument.Parse("""[{"inner":{"target":null}}]""").RootElement.Clone();
        var errors = Validate(col, json);

        Assert.Single(errors);
        Assert.Equal("links[0].inner.target", errors[0].FieldPath);
        Assert.Equal("null_not_allowed", errors[0].Reason);
    }
}
