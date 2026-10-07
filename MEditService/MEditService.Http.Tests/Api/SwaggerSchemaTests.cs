using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SwaggerSchemaTests
{
    private static async Task<JsonElement> GetSchemaAsync()
    {
        await using var app = new MEditHost();
        var client = app.CreateClient();
        var body = await client.GetStringAsync("/swagger/v1/swagger.json");
        return JsonDocument.Parse(body).RootElement.Clone();
    }

    [Theory]
    [InlineData("FieldMetadata", "elementType", "FieldMetadata")]
    public async Task NullableRefProperty_IsNullableViaAllOfWrapper_BecauseOpenApi30ForbidsKeywordsBesideARef(string schemaName, string propertyName, string refTarget)
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty(schemaName).GetProperty("properties").GetProperty(propertyName);

        Assert.False(prop.TryGetProperty("$ref", out _));

        Assert.True(prop.TryGetProperty("nullable", out var nullable));
        Assert.True(nullable.GetBoolean());

        Assert.True(prop.TryGetProperty("allOf", out var allOf));
        Assert.Equal(1, allOf.GetArrayLength());
        Assert.Equal(
            $"#/components/schemas/{refTarget}",
            allOf[0].GetProperty("$ref").GetString());
    }

    [Fact]
    public async Task CreatePluginRoute_DeclaresEveryStatusItsHandlerCanReturn_ElseSwashbuckleEmitsContentNever()
    {
        var root = await GetSchemaAsync();
        var responses = root.GetProperty("paths").GetProperty("/plugins/create").GetProperty("post").GetProperty("responses");

        var declared = responses.EnumerateObject().Select(p => p.Name).ToHashSet();
        Assert.Equal(new HashSet<string> { "200", "400", "404", "409", "422", "503" }, declared);
    }

    [Theory]
    [InlineData("get", "/plugins")]
    [InlineData("get", "/records")]
    [InlineData("get", "/records/{formKey}")]
    [InlineData("get", "/records/{formKey}/compare")]
    [InlineData("get", "/plugins/{plugin}/record-types")]
    [InlineData("get", "/plugins/{plugin}/records/{formKey}/children")]
    [InlineData("get", "/plugins/{plugin}/worldspaces")]
    [InlineData("get", "/plugins/{plugin}/worldspaces/{formKey}/blocks")]
    [InlineData("get", "/plugins/{plugin}/cells/{formKey}/children")]
    [InlineData("get", "/plugins/{plugin}/interior-cells")]
    public async Task ARouteThatReadsTheLoadOrder_Declares503_ElseSwashbuckleEmitsContentNeverForIt(string method, string path)
    {
        var root = await GetSchemaAsync();
        var responses = root.GetProperty("paths").GetProperty(path).GetProperty(method).GetProperty("responses");

        Assert.True(responses.TryGetProperty("503", out _));
    }

    [Fact]
    public async Task CompileRequest_CarriesThePluginsAndNoOption()
    {
        var root = await GetSchemaAsync();
        var properties = root.GetProperty("components").GetProperty("schemas")
            .GetProperty("CompileRequest").GetProperty("properties");

        Assert.Equal(["plugins"], properties.EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task CopyRoute_DeclaresOnlyTheCallLevelStatuses_ElseSwashbuckleEmitsContentNeverForAnUndeclaredOne()
    {
        var root = await GetSchemaAsync();
        var responses = root.GetProperty("paths").GetProperty("/records/copy").GetProperty("post").GetProperty("responses");

        var declared = responses.EnumerateObject().Select(p => p.Name).ToHashSet();
        Assert.Equal(new HashSet<string> { "200", "400", "500", "503" }, declared);
    }

    [Fact]
    public async Task EveryOperation_DeclaresASuccessResponse_ElseSwashbuckleEmitsContentNever()
    {
        var root = await GetSchemaAsync();
        var undeclared = Operations(root)
            .Where(op => !op.Responses.EnumerateObject().Any(r => r.Name.StartsWith('2')))
            .Select(op => op.Name)
            .ToList();
        Assert.True(undeclared.Count == 0, "No 2xx declared for:\n" + string.Join("\n", undeclared));
    }

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

    [Fact]
    public async Task NullablePropertyWithNonNullableDictionaryValue_WrapsOnlyTheProperty()
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty("FieldDiff").GetProperty("properties").GetProperty("resolutions");

        Assert.True(prop.TryGetProperty("nullable", out var nullable));
        Assert.True(nullable.GetBoolean());
        Assert.False(prop.TryGetProperty("allOf", out _));

        var additionalProperties = prop.GetProperty("additionalProperties");
        Assert.True(additionalProperties.TryGetProperty("$ref", out var reference));
        Assert.Equal("#/components/schemas/FormKeyResolution", reference.GetString());
        Assert.False(additionalProperties.TryGetProperty("nullable", out _));
        Assert.False(additionalProperties.TryGetProperty("allOf", out _));
    }

    [Theory]
    [InlineData(
        "PluginResponse",
        new[]
        {
            "name", "path", "isLight", "isMaster", "isBlueprint", "masters", "recordCount", "isImmutable",
            "origin", "inLoadOrder",
            "hasMatchingRecords", "isTracked", "hasParseFailure",
        })]
    [InlineData("CellSummary", new[] { "formKey", "isPersistentWorldspaceCell", "hasParseFailure", "hasChildren" })]
    public async Task NonNullableProperties_AreRequired_AndNullableOnesAreNot_BecauseSwashbuckleIgnoresNullableReferenceTypeAnnotations(
        string schemaName, string[] expectedRequired)
    {
        var root = await GetSchemaAsync();
        var schema = root.GetProperty("components").GetProperty("schemas").GetProperty(schemaName);

        Assert.True(schema.TryGetProperty("required", out var required), $"{schemaName} declares no `required` at all.");
        Assert.Equal(
            expectedRequired.ToHashSet(),
            required.EnumerateArray().Select(DocumentNodes.StringValueOf).ToHashSet());
    }

    [Theory]
    [InlineData("PluginResponse", "name")]
    [InlineData("PluginResponse", "origin")]
    [InlineData("PluginResponse", "masters")]
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

    [Theory]
    [InlineData("CellSummary", "editorId")]
    [InlineData("RecordSummary", "editorId")]
    [InlineData("ChangedPlugin", "bytesSha256")]
    [InlineData("PluginResponse", "masterIssues")]
    public async Task NullableReferenceProperty_IsStillDescribedAsNullable(string schemaName, string propertyName)
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty(schemaName).GetProperty("properties").GetProperty(propertyName);

        Assert.True(prop.TryGetProperty("nullable", out var nullable) && nullable.GetBoolean(),
            $"{schemaName}.{propertyName} is a nullable C# member but the schema does not say so.");
    }

    [Theory]
    [InlineData("WorkingTreeState", new[] { "None", "Modified", "Added" })]
    [InlineData("TrackPhase", new[] { "Idle", "Parsing", "Serializing", "Committing" })]
    [InlineData("LoadOrderState", new[] { "None", "Reconciling", "Ready", "HeldElsewhere", "Failed" })]
    public async Task WireEnum_SerializesAsStringUnion_BecauseSwashbuckleHonoursOnlyAPerEnumConverter(string schemaName, string[] expectedMembers)
    {
        var root = await GetSchemaAsync();
        var schema = root.GetProperty("components").GetProperty("schemas").GetProperty(schemaName);

        Assert.Equal("string", schema.GetProperty("type").GetString());
        Assert.Equal(expectedMembers, schema.GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
    }
}
