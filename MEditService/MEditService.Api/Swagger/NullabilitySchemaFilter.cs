using System.Reflection;
using System.Text.Json;
using Microsoft.OpenApi;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace MEditService.Api.Swagger;

// Swashbuckle ignores nullable-reference annotations, so every DTO property would be optional and
// nullable. Non-nullable properties become `required`; a nullable $ref is wrapped in allOf, since
// OpenAPI 3.0 forbids `nullable` beside a bare $ref (#627, #644).
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
            }
            else if (concrete.Properties[name] is OpenApiSchemaReference propSchema)
            {
                concrete.Properties[name] = new OpenApiSchema
                {
                    AllOf = [propSchema],
                    Type = JsonSchemaType.Null,
                };
            }

            WrapNullableDictionaryValue(concrete.Properties[name], property);
        }
    }

    // Keyed off the dictionary's value generic argument, not the property's own nullability, which
    // is an unrelated axis; additionalProperties is a separate code path from the property walk (#644).
    private static void WrapNullableDictionaryValue(IOpenApiSchema propertySchema, PropertyInfo property)
    {
        if (propertySchema is not OpenApiSchema { AdditionalProperties: OpenApiSchemaReference valueSchema } dictSchema)
            return;

        var typeArguments = NullabilityContext.Create(property).GenericTypeArguments;
        if (typeArguments.Length != 2 || typeArguments[1].WriteState != NullabilityState.Nullable) return;

        dictSchema.AdditionalProperties = new OpenApiSchema
        {
            AllOf = [valueSchema],
            Type = JsonSchemaType.Null,
        };
    }

    // Reverses the camelCase naming policy Swashbuckle applies. A property this cannot resolve is
    // left optional, the safe direction: a wrongly-optional field costs a `??`, a wrongly-required
    // one is a lie.
    private static PropertyInfo? FindProperty(Type type, string jsonName) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name) == jsonName);

    // Covers value types too: NullabilityInfoContext reports `int` as NotNull and `int?` as
    // Nullable, so an explicit IsValueType branch is redundant.
    private static bool IsNonNullable(PropertyInfo property) =>
        NullabilityContext.Create(property).WriteState == NullabilityState.NotNull;
}
