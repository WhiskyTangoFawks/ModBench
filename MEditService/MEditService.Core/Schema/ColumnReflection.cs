using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>One record type's top-level columns: every member of its getter interface that is not
/// record-header metadata, built by the same leaf builders every nested member uses.</summary>
internal static class ColumnReflection
{
    // Declared by Mutagen.Bethesda.Core's IMajorRecordGetter for every game: identity and header
    // metadata, never a column. Per-game header-adjacent members (GRUP timestamps) are
    // SchemaAnnotations.ExcludedColumns instead.
    private static readonly HashSet<string> MajorRecordHeaderMembers = new(StringComparer.OrdinalIgnoreCase)
    {
        nameof(IMajorRecordGetter.FormKey), nameof(IMajorRecordGetter.EditorID),
        nameof(IMajorRecordGetter.IsCompressed), nameof(IMajorRecordGetter.FormVersion),
        nameof(IMajorRecordGetter.VersionControl), nameof(IMajorRecordGetter.MajorRecordFlagsRaw),
    };

    internal static List<ColumnSpec> ReflectColumns(
        Type getterType, GameReflection game, ILogger logger)
    {
        var grouped = ReflectedTypes.GetAllInterfaceProperties(getterType)
            .Where(p => !MajorRecordHeaderMembers.Contains(p.Name))
            .Where(p => !game.Annotations.IsExcludedColumn(p))
            .Where(p => !game.Annotations.IsExcludedMember(p))
            .Where(p => !SchemaRefusals.IsExcludedUnionColumn(p, game))
            .GroupBy(p => p.Name, StringComparer.Ordinal);

        var columns = new List<ColumnSpec>();

        foreach (var group in grouped)
        {
            var prop = ReflectedTypes.MostDerived(group);
            if (BuildColumn(prop, prop.Name, game, logger) is { } column) columns.Add(column);
        }

        columns.AddRange(SyntheticColumns.For(getterType, game, backingPathPrefix: "", backingNames: _ => LeafSpec.NoEnumMembers));
        return columns;
    }

    /// <summary>One member as a column: the spec every walk builds it as, plus its database facts.
    /// An array or a struct is one JSON node no view has a scalar reading of.</summary>
    internal static ColumnSpec? BuildColumn(
        PropertyInfo prop, string propertyName, GameReflection game, ILogger logger)
    {
        var (core, nullable) = ReflectedTypes.CoreOf(prop);

        if (LeafClassification.ClassifyLeaf(prop, core, game) is { } leaf)
        {
            return new ColumnSpec(
                SubFieldReflection.ProjectSubField(prop, nullable, leaf, game), propertyName, leaf.DuckDbType,
                // A nullable property genuinely can be absent-meaning-null, so it keeps NULL rather
                // than being coalesced to a default it never had.
                ViewDefaultLiteral: nullable ? null : leaf.ViewDefaultLiteral);
        }

        return SubFieldReflection.GetSubFieldInfo(prop, game, SubFieldReflection.RootPath, logger) is { } spec
            ? new ColumnSpec(spec, propertyName, "VARCHAR")
            : null;
    }
}
