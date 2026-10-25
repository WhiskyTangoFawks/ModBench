using System.Text.Json;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class CheckErrorBuilderTests
{
    private sealed record Case(FieldMetadata Meta, string? Json, Func<string, ResolvedFormKey?> Resolve, string? MissingStringsFile = null);

    private static readonly FieldMetadata RaceLink = new("Race", "formKey", false, ["race"], [], AllowsNull: false);

    private static readonly FieldMetadata TranslatedName = new("Name", "translatedString", false, [], [], AllowsNull: true);

    private static readonly FieldMetadata Factions = new("Factions", "array", true, [], [],
        ElementType: new FieldMetadata("", "struct", false, [], [], Fields: [new FieldMetadata("Faction", "formKey", false, ["fact"], [], AllowsNull: false)]));

    private static readonly Func<string, ResolvedFormKey?> Unresolved = _ => null;

    private static Func<string, ResolvedFormKey?> Resolving(string recordType) => _ => new ResolvedFormKey(recordType, null);

    private static readonly Dictionary<string, Case> Cases = new(StringComparer.Ordinal)
    {
        ["a translated string holding only its target language"] =
            new(TranslatedName, """{"TargetLanguage":"English"}""", Unresolved, "Test_en.STRINGS"),
        ["a translated string holding its text"] =
            new(TranslatedName, """{"TargetLanguage":"English","Value":"A Door"}""", Unresolved, "Test_en.STRINGS"),
        ["a translated string holding its text in every language"] =
            new(TranslatedName, """{"TargetLanguage":"English","Values":[{"Language":"English","String":"A Door"}]}""", Unresolved, "Test_en.STRINGS"),
        ["an absent translated string"] = new(TranslatedName, null, Unresolved, "Test_en.STRINGS"),
        ["a translated string of a plugin missing no strings file"] = new(TranslatedName, """{"TargetLanguage":"English"}""", Unresolved),
        ["a link to a record of its type"] = new(RaceLink, "\"000001:Test.esp\"", Resolving("race")),
        ["a null link that may be null"] = new(RaceLink with { AllowsNull = true }, null, Resolving("race")),
        ["a null link that may not be null"] = new(RaceLink, null, Resolving("race")),
        ["a dangling link"] = new(RaceLink, "\"000FFF:Test.esp\"", Unresolved),
        ["a link to a record of another type"] =
            new(RaceLink with { ValidFormKeyTypes = ["npc_", "lvln", "kywd"] }, "\"000001:Test.esp\"", Resolving("race")),
        ["a field that is no link"] = new(new FieldMetadata("Height", "float", false, [], []), "1.5", Unresolved),
        ["a list of links, one dangling"] = new(
            new FieldMetadata("Keywords", "array", true, [], [], ElementType: new FieldMetadata("", "formKey", false, ["kywd"], [], AllowsNull: true)),
            """["000001:Test.esp", null, "000FFF:Test.esp"]""",
            key => key == "000001:Test.esp" ? new ResolvedFormKey("kywd", null) : null),
        ["a null link in a list of structs"] = new(Factions, """[{"Faction": null, "Rank": 0}]""", Unresolved),
        ["a link a stored document omits in a list of structs"] = new(Factions, """[{"Rank": 0}]""", Unresolved),
        ["a null link two structs down"] = new(
            new FieldMetadata("links", "array", true, [], [], ElementType: new FieldMetadata("", "struct", false, [], [],
                Fields: [new FieldMetadata("inner", "struct", false, [], [], Fields: [new FieldMetadata("Target", "formKey", false, ["kywd"], [], AllowsNull: false)])])),
            """[{"inner":{"Target":null}}]""",
            Unresolved),
        ["an absent link with a declared default"] = new(
            new FieldMetadata("Owner", "struct", false, [], [], Fields: [new FieldMetadata("Link", "formKey", false, ["npc_"], [], AllowsNull: false, Default: "000001:Test.esp")]),
            "{}",
            key => key == "000001:Test.esp" ? new ResolvedFormKey("race", null) : null),
    };

    private static string? Built(string name)
    {
        var (meta, json, resolve, missingStringsFile) = Cases[name];
        return CheckErrorBuilder.Build(
            meta, json is null ? null : JsonSerializer.Deserialize<JsonElement>(json), resolve, GameRelease.Fallout4,
            indexed: true, missingStringsFile: missingStringsFile);
    }

    [Theory]
    [InlineData("a translated string holding only its target language", "Test_en.STRINGS")]
    [InlineData("a null link that may not be null", "Found a NULL reference, expected: RACE")]
    [InlineData("a dangling link", "[000FFF:Test.esp] <Error: Could not be resolved>")]
    [InlineData("a link to a record of another type", "Found a RACE reference, expected: KYWD, LVLN, NPC_")]
    [InlineData("a list of links, one dangling", "[2]: [000FFF:Test.esp] <Error: Could not be resolved>")]
    [InlineData("a null link in a list of structs", "[0].Faction: Found a NULL reference, expected: FACT")]
    [InlineData("a link a stored document omits in a list of structs", "[0].Faction: Found a NULL reference, expected: FACT")]
    [InlineData("a null link two structs down", "[0].inner.Target: Found a NULL reference, expected: KYWD")]
    [InlineData("an absent link with a declared default", "Link: Found a RACE reference, expected: NPC_")]
    public void AFieldInError_IsReportedAtItsPath(string name, string expected) =>
        Assert.Equal(expected, Built(name));

    [Theory]
    [InlineData("a translated string holding its text")]
    [InlineData("a translated string holding its text in every language")]
    [InlineData("an absent translated string")]
    [InlineData("a translated string of a plugin missing no strings file")]
    [InlineData("a link to a record of its type")]
    [InlineData("a null link that may be null")]
    [InlineData("a field that is no link")]
    public void ACleanField_ReportsNothing(string name) =>
        Assert.Null(Built(name));
}
