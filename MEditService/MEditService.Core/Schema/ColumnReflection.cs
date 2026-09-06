using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>One record type's top-level columns: every member of its getter interface that is not
/// record-header metadata, dispatched to its leaf kind and projected into a
/// <see cref="ColumnSpec"/> named by the member itself.</summary>
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
            var info = GetColumnInfo(prop, game, logger);
            if (info == null) continue;

            columns.Add(new ColumnSpec(
                prop.Name, prop.Name, info.DuckDbType, info.ApiType,
                info.ValidFormKeyTypes, info.EnumMembers,
                IsArray: info.ApiType == "array",
                ElementType: info.ElementMeta,
                SubFields: info.SubFieldMetas,
                AllowsNull: info.AllowsNull,
                ViewDefaultLiteral: info.ViewDefaultLiteral,
                KeyMembers: info.KeyMembers,
                LeafTypeName: info.LeafTypeName,
                Default: info.Default));
        }

        columns.AddRange(SyntheticColumns.For(getterType, game, backingPathPrefix: "", backingNames: _ => LeafSpec.NoEnumMembers));
        return columns;
    }

    private static ColumnInfoResult? GetColumnInfo(
        PropertyInfo prop, GameReflection game, ILogger logger)
    {
        var type = prop.PropertyType;
        var core = Nullable.GetUnderlyingType(type) ?? type;
        var nullable = Nullable.GetUnderlyingType(type) != null || !type.IsValueType;

        return LeafClassification.ClassifyLeaf(prop, core, game) switch
        {
            { } leaf => ProjectColumn(nullable, leaf),
            null when ReflectedTypes.IsListType(core, out var elementType) => ListLeaves.BuildListColumn(prop, elementType, game, logger),
            null when ReflectedTypes.IsLoquiInterface(core) => StructLeaves.BuildStructColumn(prop, core, game, logger),
            _ => SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, core, "column"),
        };
    }

    private static ColumnInfoResult ProjectColumn(bool nullable, LeafSpec leaf)
    {
        return new(leaf.DuckDbType, leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumMembers,
            AllowsNull: leaf.AllowsNull,
            // A nullable property genuinely can be absent-meaning-null, so it keeps NULL rather than
            // being coalesced to a default it never had.
            ViewDefaultLiteral: nullable ? null : leaf.ViewDefaultLiteral,
            Default: nullable ? null : leaf.Default);
    }
}
