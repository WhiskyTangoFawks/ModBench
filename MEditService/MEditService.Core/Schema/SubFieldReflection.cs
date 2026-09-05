using System.Reflection;
using MEditService.Core.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>The walk below a record column, limited by the visited-type path, whose re-entry is
/// fatal unless annotated as a truncation point, and the depth cap, which bounds struct nesting
/// and resets across a list hop.</summary>
internal static class SubFieldReflection
{
    // Walks only what getterInterface declares or inherits, never a more-derived sibling interface, so
    // a union's leaf members are unreachable from the base alone; ObjectModPropertyLeaves and
    // LoquiUnions close that gap below.
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
            .GroupBy(p => p.Name, StringComparer.Ordinal);

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

    // Re-entering a type on the path is a fatal cycle, except through a truncation point the game's
    // format cannot nest past. The depth cap resets across a list hop, so a list cycle is invisible
    // to it.
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
            // scalar anyway, so default permissive here regardless.
            return new FieldMetadata("", "formKey", false,
                LeafClassification.GetFormLinkValidTypes(core, game), LeafSpec.NoEnumMembers,
                IsSortable: true, AllowsNull: true);
        }

        if (ReflectedTypes.IsLoquiInterface(core))
            return StructElementMeta(BuildSubSchema(core, game, logger, path), core);

        return core switch
        {
            _ when core == typeof(float) => new("", "float", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when core == typeof(string) => new("", "string", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when ReflectedTypes.IsTranslatedString(core) => new("", "translatedString", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when ReflectedTypes.IntegerTypes.Contains(core) => new("", "int", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when core == typeof(bool) => new("", "bool", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when ByteSliceHex.IsByteSlice(core) => new("", ByteSliceHex.HexApiType, false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ when ReflectedTypes.IsVectorStructType(core) => new("", "vector", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            _ => null,
        };
    }

    // An element has no name of its own — its members and the class it is are what identify it.
    // A shape with no members is not one the walk can present, and is left out of the array.
    private static FieldMetadata? StructElementMeta(List<SubFieldSpec> members, Type core) =>
        members.Count == 0
            ? null
            : new FieldMetadata("", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                Fields: [.. members.Select(s => s.ToFieldMetadata())],
                LeafTypeName: ReflectedTypes.LeafTypeName(core));

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

        return LeafClassification.ClassifyLeaf(prop, core, game) switch
        {
            { } leaf => ProjectSubField(prop, core, nullable, leaf, game, logger),
            null when ReflectedTypes.IsListType(core, out var elementType) =>
                ListLeaves.BuildListSubField(prop, elementType, game, path, logger),
            null when ReflectedTypes.IsLoquiInterface(core) => StructLeaves.BuildStructSubField(prop, core, game, path, depth, logger),
            _ => SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "sub-field"),
        };
    }

    // Routed through the same writer as a top-level column, so every leaf shape has one write path.
    private static SubFieldSpec ProjectSubField(
        PropertyInfo prop, Type core, bool nullable, LeafSpec leaf,
        GameReflection game, ILogger logger)
    {
        var apply = LeafWriters.RouteWriter<object>(leaf, prop, core, nullable, game, logger);
        return new(prop.Name, leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumMembers,
            apply,
            AllowsNull: leaf.AllowsNull,
            SiblingsInUse: game.Annotations.SiblingsInUseFor(prop),
            Default: nullable ? null : leaf.Default);
    }
}
