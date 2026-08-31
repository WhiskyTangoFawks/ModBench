using System.Reflection;
using System.Text.Json;
using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace MEditService.Api.Swagger;

// Swashbuckle does not read C#'s nullable-reference-type annotations, so left alone it describes
// every property of every DTO as both optional and nullable. This filter is the one place that
// mismatch is corrected, and it makes two edits per schema, both driven by the same
// NullabilityInfoContext reading of the CLR property:
//
//   1. Non-nullable property -> `required`. Without it openapi-typescript emits `name?: string`
//      for a C# `string Name`, and the frontend has to re-assert non-nullability by hand at every
//      field of every response (#627).
//   2. Nullable *object-typed* property -> allOf-wrapped $ref. OpenAPI 3.0 forbids sibling
//      keywords next to a $ref, so Swashbuckle never emits `nullable: true` alongside a bare one
//      and a genuinely-nullable ref silently loses its nullability. Wrapping in `allOf` gives
//      `nullable` somewhere to attach. Only a bare $ref needs this — an array/dictionary of refs
//      carries its own inline schema, which can already take a `nullable` sibling.
//
// The two halves are complementary, never both applied to one property: (1) fires on the
// non-nullable ones, (2) on the nullable ones.
public sealed class NullabilitySchemaFilter : ISchemaFilter
{
    private static readonly NullabilityInfoContext NullabilityContext = new();

    public void Apply(IOpenApiSchema schema, SchemaFilterContext context)
    {
        if (schema is not OpenApiSchema concrete || concrete.Properties is null) return;

        foreach (var name in concrete.Properties.Keys.ToList())
        {
            var property = FindProperty(context.Type, name);
            if (property is null) continue;

            if (IsNonNullable(property))
            {
                concrete.Required ??= new HashSet<string>();
                concrete.Required.Add(name);
                continue;
            }

            if (concrete.Properties[name] is OpenApiSchemaReference propSchema)
            {
                concrete.Properties[name] = new OpenApiSchema
                {
                    AllOf = [propSchema],
                    Type = JsonSchemaType.Null,
                };
            }
        }
    }

    // Reverses the default ASP.NET Core camelCase JSON naming policy Swashbuckle applies to find
    // the CLR property a generated schema property name came from. A property this cannot resolve
    // (none today) is left exactly as Swashbuckle emitted it — optional — which is the safe
    // direction: a wrongly-optional field costs a `??`, a wrongly-required one is a lie.
    private static PropertyInfo? FindProperty(Type type, string jsonName) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name) == jsonName);

    // Covers value types too, with no branch of its own: NullabilityInfoContext reports `int` as
    // NotNull and `int?` as Nullable, so one question answers both halves of the problem. Verified,
    // not assumed — an explicit `IsValueType ? Nullable.GetUnderlyingType(..) is null : ..` branch
    // was written first and proved redundant against SwaggerSchemaTests' CellSummary case, whose
    // `int? CellX`/`CellY` stay out of `required` either way.
    private static bool IsNonNullable(PropertyInfo property) =>
        NullabilityContext.Create(property).WriteState == NullabilityState.NotNull;
}
