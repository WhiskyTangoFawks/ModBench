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

    // The members of the header the editor presents, and why a write reaching each is refused. A mod
    // header is not a major record, so the table names them; each is built by the same builder every
    // record column is.
    private static readonly (string Member, string ReadOnlyReason)[] PresentedMembers =
    [
        ("Author", SchemaRefusals.HeaderNoWritePathReason),
        ("Flags", SchemaRefusals.HeaderNoWritePathReason),
        // Masters are read-only: content-derived at compile time (ADR-0008), so a write reaching
        // them is refused FieldReadOnly.
        (PluginHeader.MastersFieldName, "masters are wholly content-derived at compile time"),
    ];

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
        var columns = new List<ColumnSpec>();

        foreach (var (member, readOnlyReason) in PresentedMembers)
        {
            var prop = headerGetterType.GetProperty(member, BindingFlags.Public | BindingFlags.Instance);
            if (prop == null)
            {
                logger.LogWarning("No {Member} found on {HeaderType}; that header column is omitted", member, headerGetterType);
                continue;
            }

            // A member the builder declines has already said so through SchemaRefusals.
            if (ColumnReflection.BuildColumn(prop, $"{modHeaderProp.Name}.{prop.Name}", game, logger) is { } column)
                columns.Add(column with { Field = column.Field with { ReadOnlyReason = readOnlyReason } });
        }

        // The ESL flag's door: a synthetic bit of the flags column, spelled in the document as that
        // column's own member names.
        columns.AddRange(SyntheticColumns.For(
            headerGetterType, game, backingPathPrefix: modHeaderProp.Name + ".",
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
