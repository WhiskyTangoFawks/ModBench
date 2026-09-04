using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>The synthetic "header" schema: a plugin's own ModHeader as a record table, whose columns
/// hang off an <c>IModGetter</c> rather than an <c>IMajorRecordGetter</c>.</summary>
internal static class ModHeaderSchema
{
    internal static void AddHeaderSchemaIfAvailable(
        Dictionary<string, RecordTableSchema> schemas, GameCategory category, Assembly assembly,
        GameReflection game, ILogger logger)
    {
        if (BuildHeaderSchema(category, assembly, game, logger) is { } headerSchema)
            schemas[HeaderIndexer.RecordType] = headerSchema;
    }

    // A mod header is not a major record, so it is hand-assembled; HeaderColumnExtract, aligned with
    // RecordColumns, is the read. PropertyName carries the "ModHeader." prefix because the header's
    // document is the whole mod's root RecordData.json.
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
        var extracts = new List<Func<IModGetter, object?>>();

        var authorProp = headerGetterType.GetProperty("Author", BindingFlags.Public | BindingFlags.Instance);
        if (authorProp != null && LeafClassification.ClassifyLeaf(authorProp, authorProp.PropertyType, game) is { } authorLeaf)
        {
            // Author is a string, so ClassifyLeaf answers a null default: absent means "no author" and
            // NULL is the honest rendering.
            columns.Add(new ColumnSpec("author", HeaderDocumentPath(modHeaderProp, authorProp), authorLeaf.DuckDbType, _ => null,
                authorLeaf.ApiType, authorLeaf.ValidFormKeyTypes, authorLeaf.EnumMembers,
                Apply: LeafWrite.ReadOnly<IMajorRecord>(SchemaRefusals.HeaderNoWritePathReason),
                ViewDefaultLiteral: authorLeaf.ViewDefaultLiteral));
            extracts.Add(HeaderPropertyExtract(modHeaderProp, authorLeaf.Get));
        }
        else
        {
            logger.LogWarning("No Author property found on {HeaderType}; header author column omitted", headerGetterType);
        }

        var flagsProp = headerGetterType.GetProperty("Flags", BindingFlags.Public | BindingFlags.Instance);
        if (flagsProp?.PropertyType.IsEnum == true)
        {
            var flagsLeaf = LeafClassification.ClassifyEnumLeaf(flagsProp, flagsProp.PropertyType);

            // Only the header's flags take xEdit's display names. IsFlagsEnum is load-bearing: the
            // serializer writes a [Flags] enum as a name array, and without it the view casts that
            // array to BIGINT and fails to bind.
            var displayMembers = flagsLeaf.EnumMembers
                .Select(m => m with { Value = MapToXEditFlagName(m.Value) }).ToArray();
            columns.Add(new ColumnSpec("flags", HeaderDocumentPath(modHeaderProp, flagsProp), flagsLeaf.DuckDbType, _ => null,
                flagsLeaf.ApiType, flagsLeaf.ValidFormKeyTypes, displayMembers,
                Apply: LeafWrite.ReadOnly<IMajorRecord>(SchemaRefusals.HeaderNoWritePathReason),
                IsFlagsEnum: flagsLeaf.IsFlagsEnum, ViewDefaultLiteral: flagsLeaf.ViewDefaultLiteral));
            extracts.Add(HeaderPropertyExtract(modHeaderProp, flagsLeaf.Get));
        }
        else
        {
            logger.LogWarning("No Flags enum property found on {HeaderType}; header flags column omitted", headerGetterType);
        }

        // Masters comes straight off the game-agnostic IModGetter, so its path is spelled directly. It
        // is read-only: masters are content-derived at compile time (ADR-0038), and a write reaching
        // it is refused FieldReadOnly.
        var mastersElement = new FieldMetadata("", "string", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);
        columns.Add(new ColumnSpec(HeaderIndexer.MastersFieldName, $"{modHeaderProp.Name}.MasterReferences", "VARCHAR", _ => null, "array",
            LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            Apply: LeafWrite.ReadOnly<IMajorRecord>(
                "masters are wholly content-derived at compile time (#335/ADR-0038)"),
            IsArray: true, ElementType: mastersElement));
        extracts.Add(mod => JsonSerializer.Serialize(mod.MasterReferences.Select(r => r.Master.FileName.ToString()).ToList()));

        return new RecordTableSchema
        {
            TableName = HeaderIndexer.RecordType,
            DisplayName = RecordDisplayNames.For(HeaderIndexer.RecordType),
            RecordType = headerGetterType,
            RecordColumns = columns,
            HeaderColumnExtract = extracts,
        };
    }

    private static Func<IModGetter, object?> HeaderPropertyExtract(PropertyInfo modHeaderProp, Func<object, object?> leafGet) =>
        mod => modHeaderProp.GetValue(mod) is { } header ? leafGet(header) : null;

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
