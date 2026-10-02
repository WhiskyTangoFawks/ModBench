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

    // The members of the header the editor presents: first the TES4 record's header (wbRecordHeader
    // in wbDefinitionsCommon.pas) under xEdit's labels, in its order, then the rest. A mod header is
    // not a major record, so the table names them, with why a write reaching one is refused.
    private static readonly (string Member, string? HeaderLabel, string? ReadOnlyReason)[] PresentedMembers =
    [
        ("Flags", "Record Flags", null),
        ("FormID", "FormID", PluginHeader.FormIdReadOnly),
        ("Version", "Version Control Info 1", null),
        ("FormVersion", "Form Version", null),
        ("Version2", "Version Control Info 2", null),
        ("Author", null, null),
        // Content-derived at compile time (ADR-0008).
        (PluginHeader.MastersFieldName, null, "masters are wholly content-derived at compile time"),
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
        var pathPrefix = $"{modHeaderProp.Name}.";
        var columns = new List<ColumnSpec>();
        foreach (var (member, headerLabel, readOnlyReason) in PresentedMembers)
        {
            var prop = headerGetterType.GetProperty(member, BindingFlags.Public | BindingFlags.Instance);
            if (prop == null)
            {
                logger.LogWarning("No {Member} found on {HeaderType}; that header column is omitted", member, headerGetterType);
                continue;
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
