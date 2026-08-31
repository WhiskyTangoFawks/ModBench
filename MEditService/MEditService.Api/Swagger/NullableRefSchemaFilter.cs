using System.Reflection;
using System.Text.Json;
using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace MEditService.Api.Swagger;

// OpenAPI 3.0 forbids sibling keywords next to $ref, so Swashbuckle never emits
// `nullable: true` alongside a bare $ref — any nullable object-typed property (a $ref, not an
// array/dictionary/primitive) silently loses its nullability in the generated spec, and
// downstream api.ts generates it without `| null` even though the C# type is genuinely nullable.
// Standard workaround: wrap the $ref in `allOf` so `nullable: true` has somewhere to attach.
public sealed class NullableRefSchemaFilter : ISchemaFilter
{
    private static readonly NullabilityInfoContext NullabilityContext = new();

    public void Apply(IOpenApiSchema schema, SchemaFilterContext context)
    {
        if (schema.Properties is null) return;

        foreach (var name in schema.Properties.Keys.ToList())
        {
            // Only a bare $ref loses nullability (an array/dictionary of refs carries its own
            // inline schema, which can already take a `nullable` sibling) — never touch anything
            // else.
            if (schema.Properties[name] is not OpenApiSchemaReference propSchema) continue;

            var property = FindProperty(context.Type, name);
            if (property is null || !IsNullableReference(property)) continue;

            schema.Properties[name] = new OpenApiSchema
            {
                AllOf = [propSchema],
                Type = JsonSchemaType.Null,
            };
        }
    }

    // Reverses the default ASP.NET Core camelCase JSON naming policy Swashbuckle applies to find
    // the CLR property a generated schema property name came from.
    private static PropertyInfo? FindProperty(Type type, string jsonName) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name) == jsonName);

    private static bool IsNullableReference(PropertyInfo property) =>
        NullabilityContext.Create(property).WriteState == NullabilityState.Nullable;
}
