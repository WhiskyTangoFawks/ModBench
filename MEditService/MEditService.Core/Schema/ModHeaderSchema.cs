using System.Reflection;
using MEditService.Core.Queries;
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

    // A mod header is not a major record, so it is hand-assembled. PropertyName carries the
    // "ModHeader." prefix because the header's document is the whole mod's root RecordData.json.
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

        var authorProp = headerGetterType.GetProperty("Author", BindingFlags.Public | BindingFlags.Instance);
        if (authorProp != null && LeafClassification.ClassifyLeaf(authorProp, authorProp.PropertyType, game) is { } authorLeaf)
        {
            // Author is a string, so ClassifyLeaf answers a null default: absent means "no author" and
            // NULL is the honest rendering.
            columns.Add(new ColumnSpec(authorProp.Name, HeaderDocumentPath(modHeaderProp, authorProp), authorLeaf.DuckDbType,
                authorLeaf.ApiType, authorLeaf.ValidFormKeyTypes, authorLeaf.EnumMembers,
                ViewDefaultLiteral: authorLeaf.ViewDefaultLiteral,
                ReadOnlyReason: SchemaRefusals.HeaderNoWritePathReason));
        }
        else
        {
            logger.LogWarning("No Author property found on {HeaderType}; header author column omitted", headerGetterType);
        }

        var flagsProp = headerGetterType.GetProperty("Flags", BindingFlags.Public | BindingFlags.Instance);
        if (flagsProp?.PropertyType.IsEnum == true)
        {
            var flagsLeaf = LeafClassification.ClassifyEnumLeaf(flagsProp.PropertyType);

            // The document carries Mutagen's member names; only the header's flags are labelled with
            // xEdit's, and a name xEdit spells the same carries no label (ADR-0034).
            var labelled = flagsLeaf.EnumMembers
                .Select(m => m with { Label = MapToXEditFlagName(m.Value) is var label && label != m.Value ? label : null })
                .ToArray();
            columns.Add(new ColumnSpec(flagsProp.Name, HeaderDocumentPath(modHeaderProp, flagsProp), flagsLeaf.DuckDbType,
                flagsLeaf.ApiType, flagsLeaf.ValidFormKeyTypes, labelled,
                ViewDefaultLiteral: flagsLeaf.ViewDefaultLiteral,
                ReadOnlyReason: SchemaRefusals.HeaderNoWritePathReason));
        }
        else
        {
            logger.LogWarning("No Flags enum property found on {HeaderType}; header flags column omitted", headerGetterType);
        }

        // Masters are read-only: content-derived at compile time (ADR-0038), so a write reaching
        // them is refused FieldReadOnly.
        var mastersProp = headerGetterType.GetProperty(HeaderIndexer.MastersFieldName, BindingFlags.Public | BindingFlags.Instance);
        if (mastersProp != null
            && ReflectedTypes.IsListType(mastersProp.PropertyType, out var masterType)
            && SubFieldReflection.BuildElementMeta(masterType, game, SubFieldReflection.RootPath, logger) is { } masterElement)
        {
            columns.Add(new ColumnSpec(mastersProp.Name, HeaderDocumentPath(modHeaderProp, mastersProp), "VARCHAR", "array",
                LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                IsArray: true, ElementType: masterElement,
                ReadOnlyReason: "masters are wholly content-derived at compile time"));
        }
        else
        {
            logger.LogWarning("No MasterReferences list found on {HeaderType}; header masters column omitted", headerGetterType);
        }

        // The ESL flag's door: a synthetic bit of the flags column, spelled in the document as that
        // column's own member names.
        columns.AddRange(SyntheticColumns.For(
            headerGetterType, game, backingPathPrefix: modHeaderProp.Name + ".",
            backingNames: member => columns.FirstOrDefault(c => c.Name == member)?.EnumMembers ?? LeafSpec.NoEnumMembers));

        return new RecordTableSchema
        {
            TableName = HeaderIndexer.RecordType,
            DisplayName = RecordDisplayNames.For(HeaderIndexer.RecordType),
            RecordType = headerGetterType,
            RecordColumns = columns,
            IsHeader = true,
        };
    }

    // Built from the reflected names rather than a literal so it follows a rename of either property.
    private static string HeaderDocumentPath(PropertyInfo modHeaderProp, PropertyInfo leafProp) =>
        $"{modHeaderProp.Name}.{leafProp.Name}";

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
