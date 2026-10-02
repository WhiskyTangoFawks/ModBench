using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>The synthetic "header" schema: a plugin's own ModHeader as a record table, whose columns
/// sit one level into the whole mod's root <c>RecordData.json</c>.</summary>
internal static class ModHeaderSchema
{
    internal static void AddHeaderSchemaIfAvailable(
        Dictionary<string, RecordTableSchema> schemas, GameCategory category, Assembly assembly,
        GameReflection game, ILogger logger)
    {
        if (BuildHeaderSchema(category, assembly, game, logger) is { } headerSchema)
            schemas[PluginHeader.RecordType] = headerSchema;
    }

    // PropertyName carries the "ModHeader." prefix because the header's document is the whole mod's
    // root RecordData.json.
    private static RecordTableSchema? BuildHeaderSchema(
        GameCategory category, Assembly assembly,
        GameReflection game, ILogger logger)
    {
        var modGetterType = assembly.GetType($"Mutagen.Bethesda.{category}.I{category}ModGetter");
        var modHeaderProp = modGetterType?.GetProperty("ModHeader", BindingFlags.Public | BindingFlags.Instance);
        if (modHeaderProp == null)
        {
            logger.LogWarning("No ModHeader property found for {Category}; header record unavailable", category);
            return null;
        }

        var headerGetterType = modHeaderProp.PropertyType;
        var pathPrefix = $"{modHeaderProp.Name}.";
        var columns = new List<ColumnSpec>();
        foreach (var (typeName, member, headerLabel, readOnlyReason) in game.Annotations.PluginHeaderMembers)
        {
            if (headerGetterType.Name != typeName || headerGetterType.GetProperty(member, BindingFlags.Public | BindingFlags.Instance) is not { } prop)
            {
                throw new InvalidOperationException(
                    $"{nameof(SchemaAnnotations.PluginHeaderMembers)}: {typeName}.{member} is no member of {headerGetterType.Name}, the plugin header's type");
            }

            // A member the builder declines has already said so through SchemaRefusals.
            if (ColumnReflection.BuildColumn(prop, pathPrefix + prop.Name, game, logger) is not { } column) continue;
            columns.Add(column with
            {
                Field = column.Field with
                {
                    DisplayLabel = headerLabel ?? column.Field.DisplayLabel,
                    IsRecordHeaderMember = headerLabel != null,
                    ReadOnlyReason = readOnlyReason ?? column.Field.ReadOnlyReason,
                },
            });
        }

        // The ESL flag's door: a synthetic bit of the flags column, spelled in the document as that
        // column's own member names.
        columns.AddRange(SyntheticColumns.For(
            headerGetterType, game, backingPathPrefix: pathPrefix,
            backingNames: member => columns.FirstOrDefault(c => c.Name == member)?.Field.EnumMembers ?? LeafSpec.NoEnumMembers));

        return new RecordTableSchema
        {
            TableName = PluginHeader.RecordType,
            DisplayName = RecordDisplayNames.For(PluginHeader.RecordType),
            RecordType = headerGetterType,
            RecordColumns = columns,
            IsHeader = true,
        };
    }
}
