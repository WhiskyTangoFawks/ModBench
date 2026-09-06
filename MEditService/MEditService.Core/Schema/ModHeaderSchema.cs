using System.Reflection;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

/// <summary>The synthetic "header" schema: a plugin's own ModHeader as a record table, whose columns
/// sit one level into the whole mod's root <c>RecordData.json</c>.</summary>
internal static class ModHeaderSchema
{
    internal static void AddHeaderSchemaIfAvailable(
        Dictionary<string, RecordTableSchema> schemas, GameCategory category, Assembly assembly,
        GameReflection game, ILogger logger)
    {
        if (BuildHeaderSchema(category, assembly, game, logger) is { } headerSchema)
            schemas[HeaderIndexer.RecordType] = headerSchema;
    }

    // The members of the header the editor presents, and why a write reaching each is refused. A mod
    // header is not a major record, so the table names them; each is built by the same builder every
    // record column is.
    private static readonly (string Member, string ReadOnlyReason)[] PresentedMembers =
    [
        ("Author", SchemaRefusals.HeaderNoWritePathReason),
        ("Flags", SchemaRefusals.HeaderNoWritePathReason),
        // Masters are read-only: content-derived at compile time (ADR-0038), so a write reaching
        // them is refused FieldReadOnly.
        (HeaderIndexer.MastersFieldName, "masters are wholly content-derived at compile time"),
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
                columns.Add(column with { ReadOnlyReason = readOnlyReason, Field = XEditLabelled(column.Field) });
        }

        // The ESL flag's door: a synthetic bit of the flags column, spelled in the document as that
        // column's own member names.
        columns.AddRange(SyntheticColumns.For(
            headerGetterType, game, backingPathPrefix: modHeaderProp.Name + ".",
            backingNames: member => columns.FirstOrDefault(c => c.Name == member)?.Field.EnumMembers ?? LeafSpec.NoEnumMembers));

        return new RecordTableSchema
        {
            TableName = HeaderIndexer.RecordType,
            DisplayName = RecordDisplayNames.For(HeaderIndexer.RecordType),
            RecordType = headerGetterType,
            RecordColumns = columns,
            IsHeader = true,
        };
    }

    // The document carries Mutagen's member names; a header column with a closed domain is labelled
    // with xEdit's, and a name xEdit spells the same carries no label (ADR-0034).
    private static SubFieldSpec XEditLabelled(SubFieldSpec field) =>
        field.EnumMembers.Count == 0
            ? field
            : field with
            {
                EnumMembers = [.. field.EnumMembers.Select(m =>
                    m with { Label = MapToXEditFlagName(m.Value) is var label && label != m.Value ? label : null })],
            };

    // Member names Mutagen uses for the light-master ("ESL") flag across games.
    private static readonly HashSet<string> LightMasterFlagNames =
        new(StringComparer.OrdinalIgnoreCase) { "Small", "LightMaster", "Light" };

    // Keyed off the Mutagen member name, never a bit position, which differs across games.
    // Optimized/Localized/Update already match xEdit's spelling; a member with no xEdit counterpart
    // (Overlay, Medium) falls through unchanged.
    internal static string MapToXEditFlagName(string mutagenName)
    {
        if (mutagenName.Equals("Master", StringComparison.OrdinalIgnoreCase)) return "ESM";
        return LightMasterFlagNames.Contains(mutagenName) ? "ESL" : mutagenName;
    }
}
