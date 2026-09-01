using System.Linq;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

// OpenAPI 3.0 forbids sibling keywords next to $ref, so Swashbuckle never emits
// `nullable: true` alongside a bare $ref for a nullable object-typed property. These assert the
// generated swagger.json directly — the actual contract openapi-typescript/api.ts consumes — via
// a bare WebApplicationFactory (schema generation needs no loaded load order, matching
// ProblemDetailsApiTests.Endpoint_NoLoadOrder_ReturnsProblemDetails).
public sealed class SwaggerSchemaTests
{
    private static async Task<JsonElement> GetSchemaAsync()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        var body = await client.GetStringAsync("/swagger/v1/swagger.json");
        return JsonDocument.Parse(body).RootElement.Clone();
    }

    // A nullable object-typed property must survive as nullable —
    // via the standard OpenAPI 3.0 workaround (allOf-wrapped ref + nullable: true), since a bare
    // $ref cannot carry a sibling `nullable` keyword.
    [Theory]
    [InlineData("FieldMetadata", "elementType", "FieldMetadata")] // FieldMetadata? ElementType
    [InlineData("CompareResult", "vmad", "VmadCompare")] // VmadCompare? Vmad
    public async Task NullableRefProperty_IsNullableViaAllOfWrapper(string schemaName, string propertyName, string refTarget)
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty(schemaName).GetProperty("properties").GetProperty(propertyName);

        // Not a bare $ref — OpenAPI 3.0 can't attach `nullable` to one.
        Assert.False(prop.TryGetProperty("$ref", out _));

        Assert.True(prop.TryGetProperty("nullable", out var nullable));
        Assert.True(nullable.GetBoolean());

        Assert.True(prop.TryGetProperty("allOf", out var allOf));
        Assert.Equal(1, allOf.GetArrayLength());
        Assert.Equal(
            $"#/components/schemas/{refTarget}",
            allOf[0].GetProperty("$ref").GetString());
    }

    // No suite-wide declared-vs-thrown ProducesProblem audit exists — this is a route-local
    // regression guard for CreatePlugin specifically, which has carried an undeclared 503 and,
    // separately, a second condition that also surfaced as 503 despite meaning something else.
    // An undeclared status makes Swashbuckle emit `content?: never` for it
    // (MEditService/CLAUDE.md's endpoint invariant).
    [Fact]
    public async Task CreatePluginRoute_DeclaresEveryStatusItsHandlerCanReturn()
    {
        var root = await GetSchemaAsync();
        var responses = root.GetProperty("paths").GetProperty("/plugins/create").GetProperty("post").GetProperty("responses");

        var declared = responses.EnumerateObject().Select(p => p.Name).ToHashSet();
        Assert.Equal(new HashSet<string> { "200", "400", "409", "500", "503" }, declared);
    }

    // The same declared-vs-thrown audit CreatePluginRoute's own test above runs, for the two
    // Copy routes — RecordEndpoints.Refusal only ever emits 409/422/404, and each handler's
    // own catch blocks add 500/503, so an undeclared status here would mean Swashbuckle silently
    // emitting `content?: never` for whichever one a client actually hits (MEditService/CLAUDE.md's
    // endpoint invariant).
    [Theory]
    [InlineData("/records/{formKey}/copy-as-override")]
    [InlineData("/records/{formKey}/copy-as-new-record")]
    public async Task CopyRoute_DeclaresEveryStatusItsHandlerCanReturn(string path)
    {
        var root = await GetSchemaAsync();
        var responses = root.GetProperty("paths").GetProperty(path).GetProperty("post").GetProperty("responses");

        var declared = responses.EnumerateObject().Select(p => p.Name).ToHashSet();
        Assert.Equal(new HashSet<string> { "200", "400", "404", "409", "422", "500", "503" }, declared);
    }

    // A non-nullable object-typed property (required ref) must stay a bare $ref — the
    // filter must not wrap indiscriminately, only genuinely-nullable properties.
    [Fact]
    public async Task NonNullableRefProperty_StaysBareRef()
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty("FieldValue").GetProperty("properties").GetProperty("metadata");

        Assert.True(prop.TryGetProperty("$ref", out var reference));
        Assert.Equal("#/components/schemas/FieldMetadata", reference.GetString());
        Assert.False(prop.TryGetProperty("nullable", out _));
        Assert.False(prop.TryGetProperty("allOf", out _));
    }

    // #644: a dictionary whose VALUE is a nullable $ref (C# `Dictionary<string, ParsedCondition?>`)
    // arrives through `additionalProperties`, not the per-property pass the two tests above cover.
    // Same OpenAPI 3.0 restriction, same fix shape: additionalProperties can't be a bare $ref next
    // to `nullable: true`, so a genuinely-nullable value needs the same allOf wrap.
    [Fact]
    public async Task NullableRefDictionaryValue_IsNullableViaAllOfWrapper()
    {
        var root = await GetSchemaAsync();
        var additionalProperties = root.GetProperty("components").GetProperty("schemas")
            .GetProperty("ConditionDiff").GetProperty("properties").GetProperty("perPlugin")
            .GetProperty("additionalProperties");

        // Not a bare $ref — OpenAPI 3.0 can't attach `nullable` to one.
        Assert.False(additionalProperties.TryGetProperty("$ref", out _));

        Assert.True(additionalProperties.TryGetProperty("nullable", out var nullable));
        Assert.True(nullable.GetBoolean());

        Assert.True(additionalProperties.TryGetProperty("allOf", out var allOf));
        Assert.Equal(1, allOf.GetArrayLength());
        Assert.Equal("#/components/schemas/ParsedCondition", allOf[0].GetProperty("$ref").GetString());
    }

    // Complement of the above, on a dictionary whose value is a non-nullable $ref (C#
    // `IReadOnlyDictionary<string, ConflictThis>`, an enum) — the filter must not wrap
    // indiscriminately, only genuinely-nullable dictionary values.
    [Fact]
    public async Task NonNullableRefDictionaryValue_StaysBareRef()
    {
        var root = await GetSchemaAsync();
        var additionalProperties = root.GetProperty("components").GetProperty("schemas")
            .GetProperty("FieldDiff").GetProperty("properties").GetProperty("cellStates")
            .GetProperty("additionalProperties");

        Assert.True(additionalProperties.TryGetProperty("$ref", out var reference));
        Assert.Equal("#/components/schemas/ConflictThis", reference.GetString());
        Assert.False(additionalProperties.TryGetProperty("nullable", out _));
        Assert.False(additionalProperties.TryGetProperty("allOf", out _));
    }

    // The discriminating control: `FieldDiff.Resolutions` is
    // `IReadOnlyDictionary<string, FormKeyResolution>? Resolutions` — the *property* is nullable,
    // but a dictionary's own schema is inline (not a bare $ref), so OpenAPI 3.0's sibling
    // restriction never applied to it in the first place: Swashbuckle's own
    // SupportNonNullableReferenceTypes already puts `nullable: true` directly on it, no allOf
    // wrap needed or present. The dictionary's *value* type (FormKeyResolution) is not nullable.
    // An implementation that reads nullability off the property instead of the dictionary's own
    // second generic type argument would wrap `additionalProperties` here too — and neither test
    // above would catch it, since one is nullable at both levels and the other at neither. This is
    // the one case nullable at exactly one of the two levels, and it must land exactly there.
    [Fact]
    public async Task NullablePropertyWithNonNullableDictionaryValue_WrapsOnlyTheProperty()
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty("FieldDiff").GetProperty("properties").GetProperty("resolutions");

        // Outer: nullable sits directly on the dictionary's own inline schema — no allOf wrap.
        Assert.True(prop.TryGetProperty("nullable", out var nullable));
        Assert.True(nullable.GetBoolean());
        Assert.False(prop.TryGetProperty("allOf", out _));

        // Inner: the dictionary's value is a non-nullable $ref and must stay bare.
        var additionalProperties = prop.GetProperty("additionalProperties");
        Assert.True(additionalProperties.TryGetProperty("$ref", out var reference));
        Assert.Equal("#/components/schemas/FormKeyResolution", reference.GetString());
        Assert.False(additionalProperties.TryGetProperty("nullable", out _));
        Assert.False(additionalProperties.TryGetProperty("allOf", out _));
    }

    // Swashbuckle never reads C#'s nullable-reference-type annotations on its own, so without a
    // filter no property lands in `required` at all and openapi-typescript types the whole wire
    // optional-and-nullable — which is what the frontend used to hand-compensate for, field by
    // field. The rule is exactly one-directional: a non-nullable CLR property is required, a
    // nullable one is not. Asserted as the *exact* set rather than a containment, so a filter that
    // over-marks (sweeping a genuinely nullable property in) fails as loudly as one that
    // under-marks.
    [Theory]
    // PluginResponse: every member is non-nullable except LoadOrderIndex (`int?` — ADR-0044's
    // honest null for a copy no plugins.txt line names), which must stay optional.
    [InlineData(
        "PluginResponse",
        new[]
        {
            "name", "path", "isLight", "isMaster", "masters", "recordCount", "isImmutable",
            "participates", "origin", "masterIssues", "inLoadOrder", "enabled", "winning",
            "hasMatchingRecords", "isTracked",
        })]
    // CellSummary: the four genuinely-nullable members (EditorId, CellX, CellY, FullName) must
    // survive as optional `| null` on the wire.
    [InlineData("CellSummary", new[] { "formKey", "isPersistentWorldspaceCell" })]
    public async Task NonNullableProperties_AreRequired_AndNullableOnesAreNot(
        string schemaName, string[] expectedRequired)
    {
        var root = await GetSchemaAsync();
        var schema = root.GetProperty("components").GetProperty("schemas").GetProperty(schemaName);

        Assert.True(schema.TryGetProperty("required", out var required), $"{schemaName} declares no `required` at all.");
        Assert.Equal(
            expectedRequired.ToHashSet(),
            required.EnumerateArray().Select(e => e.GetString()!).ToHashSet());
    }

    // `required` is only half of "non-nullable". A property can be required *and* nullable, which
    // openapi-typescript renders `name: string | null` — still forcing every consumer to unwrap a
    // null the C# `string Name` can never actually be. Swashbuckle marks every reference-typed
    // property nullable unless told otherwise, so this covers the reference types specifically;
    // value types (`bool`, `int`) were never described as nullable and need no assertion.
    [Theory]
    [InlineData("PluginResponse", "name")]
    [InlineData("PluginResponse", "origin")]
    [InlineData("PluginResponse", "masters")]      // IReadOnlyList<string> — an array is a reference type too
    [InlineData("PluginResponse", "masterIssues")] // IReadOnlyList<MasterIssue>
    [InlineData("RecordSummary", "plugin")]
    public async Task NonNullableReferenceProperty_IsNotDescribedAsNullable(string schemaName, string propertyName)
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty(schemaName).GetProperty("properties").GetProperty(propertyName);

        Assert.False(
            prop.TryGetProperty("nullable", out var nullable) && nullable.GetBoolean(),
            $"{schemaName}.{propertyName} is a non-nullable C# member but the schema says nullable.");
    }

    // The complement of the test above, on the same axis: a genuinely nullable reference-typed
    // member must keep saying so. Without this, "stop describing things as nullable" could be
    // satisfied by never describing anything as nullable.
    [Theory]
    [InlineData("CellSummary", "editorId")]        // string? EditorId
    [InlineData("RecordSummary", "editorId")]
    [InlineData("CompileResult", "refusalReason")] // string? RefusalReason
    public async Task NullableReferenceProperty_IsStillDescribedAsNullable(string schemaName, string propertyName)
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty(schemaName).GetProperty("properties").GetProperty(propertyName);

        Assert.True(prop.TryGetProperty("nullable", out var nullable) && nullable.GetBoolean(),
            $"{schemaName}.{propertyName} is a nullable C# member but the schema does not say so.");
    }

    // Swashbuckle's schema generator only honors a per-enum [JsonConverter] attribute — never the
    // global ConfigureHttpJsonOptions converter Program.cs registers — so an enum missing that
    // attribute is *described* as a numeric union while the wire actually carries strings, and a
    // client is forced to distrust its own generated type. Every enum that reaches the wire is
    // listed here. expectedMembers is the string-enum member names written out, not read from the
    // CLR type at runtime, so a renamed member fails rather than silently redefining the contract.
    //
    // WireEnumSerializationTests pins the other half: that adding the attribute changes only the
    // description and never the bytes.
    [Theory]
    [InlineData("ConditionOperator", new[] { "EqualTo", "NotEqualTo", "GreaterThan", "GreaterThanOrEqualTo", "LessThan", "LessThanOrEqualTo" })]
    [InlineData("ConditionParamCategory", new[] { "Number", "Form", "Text" })]
    [InlineData("WorkingTreeState", new[] { "None", "Modified", "Added" })]
    [InlineData("TrackPhase", new[] { "Idle", "Parsing", "Serializing", "Committing" })]
    [InlineData("CrashRepairReason", new[] { "InterruptedCompile", "MissingOrUnreadableBinary" })]
    [InlineData("LoadOrderState", new[] { "None", "Reconciling", "Ready" })]
    // RebaseOutcome reaches the wire only because RebaseResponse.Outcome names the enum; it was a
    // bare `string` filled by `.ToString()`, so the schema could say nothing better than "string".
    [InlineData("RebaseOutcome", new[] { "Clean", "Refused", "Conflicted" })]
    public async Task WireEnum_SerializesAsStringUnion(string schemaName, string[] expectedMembers)
    {
        var root = await GetSchemaAsync();
        var schema = root.GetProperty("components").GetProperty("schemas").GetProperty(schemaName);

        Assert.Equal("string", schema.GetProperty("type").GetString());
        Assert.Equal(expectedMembers, schema.GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
    }
}
