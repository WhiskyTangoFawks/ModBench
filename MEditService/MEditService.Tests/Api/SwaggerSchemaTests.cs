using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

// Issue #161: OpenAPI 3.0 forbids sibling keywords next to $ref, so Swashbuckle never emits
// `nullable: true` alongside a bare $ref for a nullable object-typed property. These assert the
// generated swagger.json directly — the actual contract openapi-typescript/api.ts consumes — via
// a bare WebApplicationFactory (schema generation needs no loaded session, matching
// ProblemDetailsApiTests.Endpoint_NoSession_ReturnsProblemDetails).
public sealed class SwaggerSchemaTests
{
    private static async Task<JsonElement> GetSchemaAsync()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        var body = await client.GetStringAsync("/swagger/v1/swagger.json");
        return JsonDocument.Parse(body).RootElement.Clone();
    }

    // Slice 1: a nullable object-typed property (bare $ref today) must survive as nullable —
    // via the standard OpenAPI 3.0 workaround (allOf-wrapped ref + nullable: true), since a bare
    // $ref cannot carry a sibling `nullable` keyword.
    [Theory]
    [InlineData("FieldMetadata", "elementType", "FieldMetadata")] // FieldMetadata? ElementType
    [InlineData("PendingChange", "recordResolution", "FormKeyResolution")] // FormKeyResolution? RecordResolution
    public async Task NullableRefProperty_IsNullableViaAllOfWrapper(string schemaName, string propertyName, string refTarget)
    {
        var root = await GetSchemaAsync();
        var prop = root.GetProperty("components").GetProperty("schemas")
            .GetProperty(schemaName).GetProperty("properties").GetProperty(propertyName);

        // Not a bare $ref (that's what today's bug produces, and OpenAPI 3.0 can't attach
        // `nullable` to it).
        Assert.False(prop.TryGetProperty("$ref", out _));

        Assert.True(prop.TryGetProperty("nullable", out var nullable));
        Assert.True(nullable.GetBoolean());

        Assert.True(prop.TryGetProperty("allOf", out var allOf));
        Assert.Equal(1, allOf.GetArrayLength());
        Assert.Equal(
            $"#/components/schemas/{refTarget}",
            allOf[0].GetProperty("$ref").GetString());
    }

    // Slice 2: a non-nullable object-typed property (required ref) must stay a bare $ref — the
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
}
