using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>One record type's top-level columns: its record header's members, then every other
/// member of its getter interface, built by the same leaf builders every nested member uses.</summary>
internal static class ColumnReflection
{
    // Declared by Mutagen.Bethesda.Core's IMajorRecordGetter for every game, and the write path's to
    // handle as the record's identity. Per-game header-adjacent members (GRUP timestamps) are
    // SchemaAnnotations.ExcludedColumns.
    private const string EditorIdMember = nameof(IMajorRecordGetter.EditorID);

    internal static List<ColumnSpec> ReflectColumns(
        Type getterType, GameReflection game, ILogger logger)
    {
        var (columns, aliases) = RecordHeaderColumns.For(getterType, game, logger);
        var notMembers = columns.Select(c => c.Name).Concat(aliases).Append(EditorIdMember)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var grouped = ReflectedTypes.GetAllInterfaceProperties(getterType)
            .Where(p => !notMembers.Contains(p.Name))
            .Where(p => !game.Annotations.IsExcludedColumn(p))
            .Where(p => !game.Annotations.IsExcludedMember(p))
            .Where(p => !SchemaRefusals.IsExcludedUnionColumn(p, game))
            .GroupBy(p => p.Name, StringComparer.Ordinal);

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
        if (SubFieldReflection.GetSubFieldInfo(prop, game, SubFieldReflection.RootPath, logger) is not { } spec)
            return null;

        if (LeafClassification.ClassifyLeaf(prop, core, game) is not { } leaf)
            return new ColumnSpec(spec, propertyName, "VARCHAR");

        // A nullable property genuinely can be absent-meaning-null, so it keeps NULL rather than
        // being coalesced to a default it never had.
        var viewDefault = nullable ? null : leaf.ViewDefaultLiteral;
        return new ColumnSpec(spec, propertyName, leaf.DuckDbType, ViewDefaultLiteral: viewDefault);
    }
}
