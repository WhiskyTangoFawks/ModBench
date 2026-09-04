using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>The synthetic "header" schema: a plugin's own ModHeader, presented as a record table.
/// Its columns hang off an <c>IModGetter</c> rather than an <c>IMajorRecordGetter</c>, which is the one
/// structural difference between this schema and every other.</summary>
internal static class ModHeaderSchema
{
    internal static void AddHeaderSchemaIfAvailable(
        Dictionary<string, RecordTableSchema> schemas, GameCategory category, Assembly assembly,
        GameReflection game, ILogger logger)
    {
        if (BuildHeaderSchema(category, assembly, game, logger) is { } headerSchema)
            schemas[HeaderIndexer.RecordType] = headerSchema;
    }

    // A mod header is not a major record in Mutagen (no FormKey/EditorID) — it can't be
    // discovered by SchemaReflector.BuildForCategory's major-record-getter scan, so it gets one hand-assembled schema
    // entry instead. Author/Flags come from a second small reflection pass over the per-game
    // ModHeader getter type (I{category}ModGetter.ModHeader), reusing the same leaf-classification
    // helpers used everywhere else; Masters comes straight off the game-agnostic IModGetter — no
    // reflection needed, since MasterReferences is already exposed generically.
    //
    // ColumnSpec.Extract is unused here (it's Func<IMajorRecordGetter, object?>; a header is never
    // one, and the header bypasses the major-record indexing loop entirely) — the real extraction is
    // HeaderColumnExtract, positionally aligned with RecordColumns.
    //
    // #631: PropertyName is the column's path *inside the header's own document*, so it carries the
    // "ModHeader." prefix (see HeaderDocumentPath). Every other schema's PropertyName is a bare CLR
    // property name because a record's document is that record; the header's document is the whole
    // mod's root RecordData.json, which nests the header one level in. Only the generated view's
    // json_extract path reads PropertyName for the header — the typed read goes through
    // HeaderColumnExtract, which reflects over the live CLR property and never sees this string.
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
            // ViewDefaultLiteral threaded through like ColumnReflection.ProjectColumn does for every other column
            // (#631, now that the header has a generated view). Author is a string, so
            // LeafClassification.ClassifyLeaf already answers null here — absent means "no author", and NULL is the
            // honest rendering, exactly what the retired wide column stored.
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

            // Only the header's flags column gets xEdit's display names — every other
            // bitmask enum in the schema (npc_, race, ...) keeps its raw Mutagen member names, so
            // this renames flagsLeaf's members here rather than inside LeafClassification.ClassifyEnumLeaf.
            // IsFlagsEnum/ViewDefaultLiteral threaded through like ColumnReflection.ProjectColumn does for every other
            // column (#631, now that the header has a generated view). Both are load-bearing rather
            // than tidy: the serializer writes a [Flags] enum as an array of member names, so without
            // IsFlagsEnum the view emits `CAST(json_extract(...) AS BIGINT)` over `["Small"]` and the
            // whole view fails to bind ("Conversion Error: Failed to cast value to numerical" —
            // observed, not hypothetical). The typed read is unaffected either way: it goes through
            // HeaderColumnExtract and IsBitmask, never this flag.
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

        // Masters comes straight off the game-agnostic IModGetter rather than through a reflected
        // ModHeader property, so its document path is spelled directly. It is read-only: masters are
        // wholly content-derived at compile time (#335/ADR-0038), and since #661 a write genuinely
        // reaches this column (EditField no longer refuses the header at the source-unit gate) and is
        // refused FieldReadOnly here — the same refusal every other header column carrying no write
        // delegate gives, not a masters-specific mechanism (see HeaderIndexer.MastersFieldName).
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

    /// <summary>Where this header property sits in the mod's own root <c>RecordData.json</c> —
    /// <c>"ModHeader.Author"</c>, not <c>"Author"</c>. Built from the reflected property names rather
    /// than a literal so it follows a rename of either, the same reason every other
    /// <c>PropertyName</c> is <c>prop.Name</c> and not a string.</summary>
    private static string HeaderDocumentPath(PropertyInfo modHeaderProp, PropertyInfo leafProp) =>
        $"{modHeaderProp.Name}.{leafProp.Name}";

    // Member names Mutagen uses for the light-master ("ESL") flag across games.
    private static readonly HashSet<string> LightMasterFlagNames =
        new(StringComparer.OrdinalIgnoreCase) { "Small", "LightMaster", "Light" };

    // xEdit's display names for the plugin header's flags, keyed off the Mutagen
    // member name (never a bit position — bit positions differ across games; see
    // wbDefinitionsFO4.pas for the source vocabulary: ESM/Localized/ESL/Update). Applies only to
    // the header's flags column (see BuildHeaderSchema); every other bitmask enum in the schema
    // keeps its raw Mutagen member names. Optimized/Localized/Update already match xEdit's own
    // spelling, so they need no entry here; a member with no xEdit counterpart at all (e.g.
    // Overlay, Medium) falls through unchanged too.
    internal static string MapToXEditFlagName(string mutagenName)
    {
        if (mutagenName.Equals("Master", StringComparison.OrdinalIgnoreCase)) return "ESM";
        return LightMasterFlagNames.Contains(mutagenName) ? "ESL" : mutagenName;
    }
}
