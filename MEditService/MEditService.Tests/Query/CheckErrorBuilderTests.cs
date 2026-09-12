using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

public class CheckErrorBuilderTests
{
    private static JsonElement J(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static readonly FieldMetadata FormKeyMeta = new(
        "Race", "formKey", false, ["race"], [], AllowsNull: false);

    private static ResolvedFormKey? Entry(string recordType) => new ResolvedFormKey(recordType, null);

    [Fact]
    public void Build_CleanScalarReference_ReturnsNull()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, J("\"000001:Test.esp\""), _ => Entry("race"), GameRelease.Fallout4);
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
        var err = CheckErrorBuilder.Build(FormKeyMeta, J("\"000FFF:Test.esp\""), _ => null, GameRelease.Fallout4);
        Assert.Equal("[000FFF:Test.esp] <Error: Could not be resolved>", err);
    }

    [Fact]
    public void Build_TypeMismatchedScalarReference_ReturnsMismatchMessage()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, J("\"000001:Test.esp\""), _ => Entry("npc_"), GameRelease.Fallout4);
        Assert.Equal("Found a npc_ reference, expected: race", err);
    }

    [Fact]
    public void Build_ArrayOfFormKey_PerElementErrors_JoinedWithSemicolon()
    {
        var elemMeta = new FieldMetadata("", "formKey", false, ["kywd"], [], AllowsNull: true);
        var meta = new FieldMetadata("Keywords", "array", true, [], [], ElementType: elemMeta);
        var value = J("""["000001:Test.esp", null, "000FFF:Test.esp"]""");

        var err = CheckErrorBuilder.Build(meta, value, fk => fk == "000001:Test.esp" ? Entry("kywd") : null, GameRelease.Fallout4);

        Assert.Equal("[2]: [000FFF:Test.esp] <Error: Could not be resolved>", err);
    }

    [Fact]
    public void Build_StructArray_FormKeySubField_ErrorIncludesIndexAndFieldName()
    {
        var factionField = new FieldMetadata("Faction", "formKey", false, ["fact"], [], AllowsNull: false);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [factionField]);
        var meta = new FieldMetadata("Factions", "array", true, [], [], ElementType: elemMeta);
        var value = J("""[{"Faction": null, "Rank": 0}]""");

        var err = CheckErrorBuilder.Build(meta, value, _ => null, GameRelease.Fallout4);

        Assert.Equal("[0].Faction: Found a NULL reference, expected: fact", err);
    }

    // A stored document omits an unset non-nullable link, which is a NULL reference worth flagging.
    [Fact]
    public void Build_AbsentNonNullableMember_IsANullReference()
    {
        var factionField = new FieldMetadata("Faction", "formKey", false, ["fact"], [], AllowsNull: false);
        var meta = new FieldMetadata("Factions", "array", true, [], [],
            ElementType: new FieldMetadata("", "struct", false, [], [], Fields: [factionField]));
        var value = J("""[{"Rank": 0}]""");

        Assert.Equal("[0].Faction: Found a NULL reference, expected: fact",
            CheckErrorBuilder.Build(meta, value, _ => null, GameRelease.Fallout4));
    }

    // An absent member with a declared default is checked as that default, not as nothing.
    [Fact]
    public void Build_AbsentMemberWithADeclaredDefault_IsCheckedAsThatDefault()
    {
        var link = new FieldMetadata("Link", "formKey", false, ["npc_"], [], AllowsNull: false, Default: "000001:Test.esp");
        var meta = new FieldMetadata("Owner", "struct", false, [], [], Fields: [link]);
        var asked = new List<string>();

        CheckErrorBuilder.Build(meta, J("{}"), key => { asked.Add(key); return Entry("npc_"); }, GameRelease.Fallout4);

        Assert.Equal(["000001:Test.esp"], asked);
    }

    [Fact]
    public void Build_EmptyValidTypes_AnyResolvedTypeAccepted()
    {
        // validTypes.Count > 0 guard: when validTypes is empty, no type_mismatch check runs.
        var meta = new FieldMetadata("Link", "formKey", false, [], [], AllowsNull: false);
        var err = CheckErrorBuilder.Build(meta, J("\"000001:Test.esp\""), _ => Entry("npc_"), GameRelease.Fallout4);
        Assert.Null(err);
    }

    [Fact]
    public void Build_NonFormKeyField_ReturnsNull()
    {
        var meta = new FieldMetadata("Height", "float", false, [], []);
        var err = CheckErrorBuilder.Build(meta, J("1.5"), _ => null, GameRelease.Fallout4);
        Assert.Null(err);
    }

    [Fact]
    public void Build_NestedStructInsideArrayStruct_FormKeyReached()
    {
        var innerFk = new FieldMetadata("Target", "formKey", false, ["kywd"], [], AllowsNull: false);
        var innerStruct = new FieldMetadata("inner", "struct", false, [], [], Fields: [innerFk]);
        var elemMeta = new FieldMetadata("", "struct", false, [], [], Fields: [innerStruct]);
        var meta = new FieldMetadata("links", "array", true, [], [], ElementType: elemMeta);
        var value = J("""[{"inner":{"Target":null}}]""");

        var err = CheckErrorBuilder.Build(meta, value, _ => null, GameRelease.Fallout4);

        Assert.Equal("[0].inner.Target: Found a NULL reference, expected: kywd", err);
    }

    // The Player and friends, in the game's implicitly-always-loaded master, never carry a
    // CheckError: a lookup miss cannot mean a broken link, since form_lookup was never going to
    // contain them.
    [Fact]
    public void Build_HardcodedFormKeyMissingFromLookup_ReturnsNull()
    {
        var err = CheckErrorBuilder.Build(FormKeyMeta, J("\"000007:Fallout4.esm\""), _ => null, GameRelease.Fallout4);
        Assert.Null(err);
    }
}
