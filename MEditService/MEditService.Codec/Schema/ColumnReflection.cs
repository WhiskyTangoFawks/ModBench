using System.Reflection;
using MEditService.Codec.Serialization;
using Microsoft.Extensions.Logging;

namespace MEditService.Codec.Schema;

/// <summary>One record type's top-level columns: its record header's members, then every other
/// member of its getter interface, built by the same leaf builders every nested member uses.</summary>
internal static class ColumnReflection
{
    internal static List<ColumnSpec> ReflectColumns(
        Type getterType, GameReflection game, ILogger logger)
    {
        var members = ReflectedTypes.Members(getterType);
        var columns = RecordHeaderColumns.For(getterType, members.ToDictionary(m => m.Key, StringComparer.Ordinal), game, logger);
        var headerOrAlias = columns.Select(c => c.Name).Concat(columns.SelectMany(c => c.Aliases))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var group in members.Where(g => !headerOrAlias.Contains(g.Key)))
        {
            var kept = group
                .Where(p => !game.Annotations.IsExcludedColumn(p))
                .Where(p => !game.Annotations.IsExcludedMember(p))
                .Where(p => !SchemaRefusals.IsExcludedUnionColumn(p, game))
                .ToList();
            if (kept.Count == 0) continue;
            var prop = ReflectedTypes.MostDerived(kept);
            if (BuildColumn(prop, prop.Name, game, logger) is not { } column) continue;
            columns.Add(prop.Name == RecordMembers.EditorId ? column with { Field = column.Field with { IsEditorId = true } } : column);
        }

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
