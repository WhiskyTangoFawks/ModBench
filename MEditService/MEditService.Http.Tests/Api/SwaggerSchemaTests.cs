using System.Linq;
using System.Text.Json;
using MEditService.Codec.Schema;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

// OpenAPI 3.0 forbids sibling keywords next to $ref, so Swashbuckle never emits `nullable: true`
// alongside a bare $ref. The generated swagger.json is asserted directly, since that is the
// contract openapi-typescript consumes.
[Collection(WebHostCollection.Name)]
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

    // An undeclared status makes Swashbuckle emit `content?: never` for it (MEditService's
    // endpoint invariant). No suite-wide declared-vs-thrown audit exists, so this is route-local.
    [Fact]
    public async Task CreatePluginRoute_DeclaresEveryStatusItsHandlerCanReturn()
    {
        var root = await GetSchemaAsync();
        var responses = root.GetProperty("paths").GetProperty("/plugins/create").GetProperty("post").GetProperty("responses");

        var declared = responses.EnumerateObject().Select(p => p.Name).ToHashSet();
        Assert.Equal(new HashSet<string> { "200", "400", "404", "409", "422", "500", "503" }, declared);
    }

    // RecordEndpoints.Refusal emits 409/422/404 and each handler's catch blocks add 500/503, so
    // an undeclared status makes Swashbuckle emit `content?: never` for whichever a client hits.
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

    // Swashbuckle types an undeclared response `content?: never` on the TS side and nothing
    // flags it, so every operation must declare its success status.
    [Fact]
    public async Task EveryOperation_DeclaresASuccessResponse()
    {
        var root = await GetSchemaAsync();
        var undeclared = Operations(root)
            .Where(op => !op.Responses.EnumerateObject().Any(r => r.Name.StartsWith('2')))
            .Select(op => op.Name)
            .ToList();
        Assert.True(undeclared.Count == 0, "No 2xx declared for:\n" + string.Join("\n", undeclared));
    }

    // An anonymous type serializes fine and reaches the TS client as an inline shape no other
    // code can name; response bodies are named records in Queries/ or Records/.
    [Fact]
    public async Task EveryJsonResponseBody_IsANamedSchema()
    {
        var root = await GetSchemaAsync();
        var anonymous = Operations(root)
            .SelectMany(op => op.Responses.EnumerateObject().Select(r => (Name: $"{op.Name} {r.Name}", Response: r.Value)))
            .Where(r => r.Response.TryGetProperty("content", out var content)
                && content.TryGetProperty("application/json", out var json)
                && !IsNamed(json.GetProperty("schema")))
            .Select(r => r.Name)
            .ToList();
        Assert.True(anonymous.Count == 0, "Inline response schema for:\n" + string.Join("\n", anonymous));
    }

    private static bool IsNamed(JsonElement schema)
    {
        if (schema.TryGetProperty("$ref", out _)) return true;
        if (schema.TryGetProperty("type", out var type) && type.GetString() == "array")
            return IsNamed(schema.GetProperty("items"));
        return schema.TryGetProperty("type", out type) && type.GetString() is "string" or "boolean" or "integer" or "number";
    }

    private static IEnumerable<(string Name, JsonElement Responses)> Operations(JsonElement root) =>
        root.GetProperty("paths").EnumerateObject()
            .SelectMany(path => path.Value.EnumerateObject()
                .Select(method => ($"{method.Name.ToUpperInvariant()} {path.Name}", method.Value.GetProperty("responses"))));

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

    // NullabilitySchemaFilter's dictionary-value rule must not wrap
    // indiscriminately: a dictionary whose value is a non-nullable $ref (C#
    // `IReadOnlyDictionary<string, ConflictThis>`, an enum) stays a bare $ref.
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

    // The discriminating control: nullable at exactly one of the two levels. An implementation
    // reading nullability off the property rather than the dictionary's value type would wrap
    // `additionalProperties` too, and neither test above is nullable at only one level.
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

    // Swashbuckle never reads C#'s nullable-reference-type annotations, so without a filter no
    // property lands in `required` and the whole wire types optional-and-nullable.
    [Theory]
    // PluginResponse: every member is non-nullable except LoadOrderIndex (`int?` — ADR-0013's
    // honest null for a copy no plugins.txt line names), which must stay optional.
    [InlineData(
        "PluginResponse",
        new[]
        {
            "name", "path", "isLight", "isMaster", "masters", "recordCount", "isImmutable",
            "participates", "origin", "masterIssues", "inLoadOrder", "enabled", "winning",
            "hasMatchingRecords", "isTracked", "hasParseFailure",
        })]
    // CellSummary: the four genuinely-nullable members (EditorId, CellX, CellY, FullName) must
    // survive as optional `| null` on the wire.
    [InlineData("CellSummary", new[] { "formKey", "isPersistentWorldspaceCell", "hasParseFailure" })]
    public async Task NonNullableProperties_AreRequired_AndNullableOnesAreNot(
        string schemaName, string[] expectedRequired)
    {
        var root = await GetSchemaAsync();
        var schema = root.GetProperty("components").GetProperty("schemas").GetProperty(schemaName);

        Assert.True(schema.TryGetProperty("required", out var required), $"{schemaName} declares no `required` at all.");
        Assert.Equal(
            expectedRequired.ToHashSet(),
            required.EnumerateArray().Select(DocumentNodes.StringValueOf).ToHashSet());
    }

    // A property can be required and nullable, which openapi-typescript renders `string | null`,
    // forcing consumers to unwrap a null the C# member cannot be. Swashbuckle marks reference
    // types nullable unless told otherwise; value types are never described that way.
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

    // Swashbuckle honors only a per-enum [JsonConverter] attribute, never the global converter, so
    // an enum missing it is described as numeric while the wire carries strings.
    [Theory]
    [InlineData("WorkingTreeState", new[] { "None", "Modified", "Added" })]
    [InlineData("TrackPhase", new[] { "Idle", "Parsing", "Serializing", "Committing" })]
    [InlineData("LoadOrderState", new[] { "None", "Reconciling", "Ready", "HeldElsewhere", "Failed" })]
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
