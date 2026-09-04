using System.Reflection;
using MEditService.Core.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>The recursive walk one level below a record column: every member of a Loqui getter
/// interface, dispatched to whichever leaf kind it is. Holds the walk's two limiters — the visited-type
/// path, whose re-entry is a fatal cycle unless the game's annotations name it a truncation point, and
/// the depth cap, which bounds struct nesting only and deliberately resets across a list hop.</summary>
internal static class SubFieldReflection
{
    // This walks only the properties declared on getterInterface and the interfaces it
    // implements/inherits — never a more-derived sibling interface. OMOD's Properties element
    // type, IAObjectModPropertyGetter<T>, declares only Property/Step; the real per-element data
    // lives on 7 separate leaf getter interfaces (IObjectModIntPropertyGetter<T>,
    // IObjectModFloatPropertyGetter<T>, ...), each implementing IAObjectModPropertyGetter<T>
    // rather than the other way around, so none of their own members are ever reached by this
    // walk alone. ObjectModPropertyLeaves.BuildObjectModPropertyLeafFields closes that gap for OMOD specifically, and
    // the same shape is generalized for every other Mutagen "A<Name>" abstract Loqui union
    // (ANpcLevel, AQuestAlias, ...) — see LoquiUnions.BuildUnionLeafFields for why OMOD's own leaves
    // still need their own hand-picked table (a generic base type with no reflectively-discoverable
    // ClassType of its own) while everything else can be discovered by reflection alone.
    internal static List<SubFieldSpec> BuildSubSchema(
        Type getterInterface,
        GameReflection game,
        ILogger logger,
        Type[] path,
        int depth = 0)
    {
        if (depth > 3) return [];
        if (Enter(path, getterInterface, game) is not { } inner) return [];

        var grouped = ReflectedTypes.GetAllInterfaceProperties(getterInterface)
            .Where(p => !game.Annotations.IsExcludedMember(p))
            .GroupBy(p => ReflectedTypes.ToSnakeCase(p.Name), StringComparer.OrdinalIgnoreCase);

        var result = new List<SubFieldSpec>();
        foreach (var group in grouped)
        {
            var prop = group.Aggregate((best, candidate) =>
                best.DeclaringType!.IsAssignableFrom(candidate.DeclaringType!) ? candidate : best);

            var spec = GetSubFieldInfo(prop, game, inner, depth + 1, logger);
            if (spec != null) result.Add(spec);
        }

        if (ObjectModPropertyLeaves.IsObjectModPropertyBase(getterInterface))
            result.AddRange(ObjectModPropertyLeaves.BuildObjectModPropertyLeafFields(getterInterface, game, logger));
        else if (LoquiUnions.TryGetUnion(getterInterface, game) is { } union)
            result.AddRange(LoquiUnions.BuildUnionLeafFields(
                getterInterface, union, game, inner, depth + 1, logger));

        return result;
    }

    internal static readonly Type[] RootPath = [];

    // The getter interfaces whose members the walk is inside, root first. Re-entering one is a
    // type cycle, fatal — except through a truncation point, a type the game's annotations say
    // its data format cannot nest past: inside any truncation point none is entered again (null),
    // and a lap that runs through one is let through, since it ends there. Depth is deliberately
    // not this: the depth cap bounds struct nesting and resets across a list hop, so a cycle
    // through a list is invisible to it.
    internal static Type[]? Enter(Type[] path, Type getterInterface, GameReflection game)
    {
        var insideTruncation = path.Any(game.Annotations.IsCycleTruncation);
        if (game.Annotations.IsCycleTruncation(getterInterface) && insideTruncation) return null;
        var lastEntry = Array.LastIndexOf(path, getterInterface);
        if (lastEntry < 0 || path.Skip(lastEntry).Any(game.Annotations.IsCycleTruncation)) return [.. path, getterInterface];
        throw new InvalidOperationException(
            "SchemaReflector: type cycle in the schema walk: " +
            $"{string.Join(" -> ", path.Append(getterInterface).Select(t => t.Name))}. " +
            "A re-entry the game's own data format cannot nest belongs in SchemaAnnotations.CycleTruncations.");
    }

    // Element metadata for use in FieldMetadata.ElementType.
    internal static FieldMetadata? BuildElementMeta(
        Type elementType, GameReflection game, Type[] path, ILogger logger)
    {
        var core = Nullable.GetUnderlyingType(elementType) ?? elementType;

        if (ReflectedTypes.IsFormLink(core))
        {
            // Array elements are commonly sparse (a "Null" slot is a tolerated placeholder, not a
            // data error) — getter interfaces can't statically distinguish this from a non-nullable
            // scalar anyway (see ReflectedTypes.IsNullableFormLink), so default permissive here regardless.
            return new FieldMetadata("", "formKey", false,
                LeafClassification.GetFormLinkValidTypes(core, game), LeafSpec.NoEnumMembers,
                IsSortable: true, AllowsNull: true);
        }

        if (ReflectedTypes.IsLoquiInterface(core))
        {
            var sub = BuildSubSchema(core, game, logger, path);
            return sub.Count == 0
                ? null
                : new FieldMetadata("", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                Fields: [.. sub.Select(s => s.ToFieldMetadata())]);
        }

        // A list of vector-struct elements (e.g. IslandData.Vertices, a list of P3Float,
        // or LocationCoordinate.Coordinates, a list of P2Int16). Without this arm, the element
        // metadata falls through to null (none of these types match the scalar cases in the switch), which
        // makes ListLeaves.BuildListColumn drop the whole field
        // — and, worse, ListLeaves.BuildListItems's own scalar-element fallback
        // (`result.Add(item)`) would hand a raw boxed vector struct straight to JsonSerializer, which
        // would recurse forever over several of these types' own self-referencing `Point` property.
        if (ReflectedTypes.IsVectorStructType(core))
        {
            var sub = VectorStructLeaves.BuildVectorComponentSubFields(core, game, 0, logger);
            return sub.Count == 0
                ? null
                : new FieldMetadata("", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                Fields: [.. sub.Select(s => s.ToFieldMetadata())]);
        }

        return core switch
        {
            _ when core == typeof(float) => new("", "float", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when core == typeof(string) || ReflectedTypes.IsTranslatedString(core) => new("", "string", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when ReflectedTypes.IntegerTypes.Contains(core) => new("", "int", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when ByteSliceHex.IsByteSlice(core) => new("", ByteSliceHex.HexApiType, false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ => null,
        };
    }

    internal static SubFieldSpec? GetSubFieldInfo(
        PropertyInfo prop,
        GameReflection game,
        Type[] path,
        int depth,
        ILogger logger)
    {
        if (depth > 3) return null;

        var type = prop.PropertyType;
        var core = Nullable.GetUnderlyingType(type) ?? type;
        var nullable = Nullable.GetUnderlyingType(type) != null || !type.IsValueType;
        var colName = ReflectedTypes.ToSnakeCase(prop.Name);

        return LeafClassification.ClassifyLeaf(prop, core, game) switch
        {
            { } leaf => ProjectSubField(prop, colName, core, nullable, leaf, game, logger),
            null when ReflectedTypes.IsAtomicValueType(core) => AtomicValueLeaves.BuildAtomicValueSubField(prop, core, colName, game, logger),
            null when ReflectedTypes.IsVectorStructType(core) => VectorStructLeaves.BuildVectorSubField(prop, core, colName, game, depth, logger),
            null when ReflectedTypes.IsListType(core, out var elementType) =>
                ListLeaves.BuildListSubField(prop, colName, elementType, game, path, logger),
            null when ReflectedTypes.IsLoquiInterface(core) => StructLeaves.BuildStructSubField(prop, core, colName, game, path, depth, logger),
            _ => SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "sub-field"),
        };
    }

    // Projects a shared LeafSpec into a sub-field, routed through the same LeafWriters.RouteWriter
    // ColumnReflection.ProjectColumn uses for a top-level column.
    private static SubFieldSpec ProjectSubField(
        PropertyInfo prop, string colName, Type core, bool nullable, LeafSpec leaf,
        GameReflection game, ILogger logger)
    {
        var apply = LeafWriters.RouteWriter<object>(leaf, core, prop.Name, nullable, logger);
        return new(colName, leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumMembers,
            leaf.Get, apply,
            AllowsNull: leaf.AllowsNull,
            SiblingsInUse: game.Annotations.SiblingsInUseFor(prop));
    }
}
