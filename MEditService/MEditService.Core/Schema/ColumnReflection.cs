using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>One record type's own top-level columns: every member of its getter interface that is not
/// record-header metadata, dispatched to whichever leaf kind it is and projected into a
/// <see cref="ColumnSpec"/>.</summary>
internal static class ColumnReflection
{
    // The record header's own members, declared by Mutagen.Bethesda.Core's IMajorRecordGetter for
    // every game: identity and header metadata, not record data, so never a column. A structural
    // fact of the base interface rather than a per-game annotation — nameof keeps it bound to the
    // real members at compile time. Per-game header-adjacent members (the GRUP timestamps a record
    // carries for the group that contains it) are SchemaAnnotations.ExcludedColumns instead.
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
            .GroupBy(p => ReflectedTypes.ToSnakeCase(p.Name), StringComparer.OrdinalIgnoreCase);

        var columns = new List<ColumnSpec>();

        foreach (var group in grouped)
        {
            var colName = group.Key;

            var prop = group.Aggregate((best, candidate) =>
                best.DeclaringType!.IsAssignableFrom(candidate.DeclaringType!) ? candidate : best);

            var info = GetColumnInfo(prop, game, logger);
            if (info == null) continue;

            columns.Add(new ColumnSpec(
                colName, prop.Name, info.DuckDbType, info.Extractor, info.ApiType,
                info.ValidFormKeyTypes, info.EnumMembers, info.Apply,
                IsArray: info.ApiType == "array",
                ElementType: info.ElementMeta,
                SubFields: info.SubFieldMetas,
                AllowsNull: info.AllowsNull,
                IsFlagsEnum: info.IsFlagsEnum,
                ViewDefaultLiteral: info.ViewDefaultLiteral,
                KeyMembers: info.KeyMembers,
                LeafTypeName: info.LeafTypeName));
        }

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
            { } leaf => ProjectColumn(prop, core, nullable, leaf, logger),
            null when ReflectedTypes.IsAtomicValueType(core) => AtomicValueLeaves.BuildAtomicValueColumn(prop, core, game, logger),
            null when ReflectedTypes.IsVectorStructType(core) => VectorStructLeaves.BuildVectorColumn(prop, core, game, logger),
            null when ReflectedTypes.IsListType(core, out var elementType) => ListLeaves.BuildListColumn(prop, elementType, game, logger),
            null when ReflectedTypes.IsLoquiInterface(core) => StructLeaves.BuildStructColumn(prop, core, game, logger),
            _ => SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, core, "column"),
        };
    }

    // Projects a shared LeafSpec into a top-level column, routed through the same
    // LeafWriters.RouteWriter its sub-field sibling uses, so every reflected leaf shape has the
    // same write path at both levels.
    private static ColumnInfoResult ProjectColumn(PropertyInfo prop, Type core, bool nullable, LeafSpec leaf, ILogger logger)
    {
        // A column's ApplyOutcome is the routed writer's own, carried straight through, and the
        // edit path turns it into a refusal naming the field (see RecordFieldWriter).
        var apply = LeafWriters.RouteWriter<IMajorRecord>(leaf, core, prop.Name, nullable, logger);
        return new(leaf.DuckDbType, r => leaf.Get(r), leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumMembers,
            apply,
            AllowsNull: leaf.AllowsNull,
            IsFlagsEnum: leaf.IsFlagsEnum,
            // A nullable property genuinely can be absent-meaning-null, so it keeps NULL rather than
            // being coalesced to a default it never had.
            ViewDefaultLiteral: nullable ? null : leaf.ViewDefaultLiteral);
    }
}
