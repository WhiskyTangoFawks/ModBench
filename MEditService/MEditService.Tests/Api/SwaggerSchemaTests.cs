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

    // ConditionOperator/ConditionParamCategory carry no per-enum [JsonConverter] attribute,
    // so Swashbuckle's schema generator (which only honors that attribute form, not the global
    // ConfigureHttpJsonOptions converter Program.cs registers) describes them as numeric unions
    // while the wire actually carries strings — same class of bug FormKeyResolutionState already
    // fixed. expectedMembers below is modeled on FormKeyResolutionState's already-fixed shape
    // (string-enum member names, not the numeric form), not read from it at runtime.
    [Theory]
    [InlineData("ConditionOperator", new[] { "EqualTo", "NotEqualTo", "GreaterThan", "GreaterThanOrEqualTo", "LessThan", "LessThanOrEqualTo" })]
    [InlineData("ConditionParamCategory", new[] { "Number", "Form", "Text" })]
    public async Task ConditionEnum_SerializesAsStringUnion(string schemaName, string[] expectedMembers)
    {
        var root = await GetSchemaAsync();
        var schema = root.GetProperty("components").GetProperty("schemas").GetProperty(schemaName);

        Assert.Equal("string", schema.GetProperty("type").GetString());
        Assert.Equal(expectedMembers, schema.GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
    }
}
