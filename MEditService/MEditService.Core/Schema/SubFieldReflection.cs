using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>The walk below a record column, limited by the visited-type path, whose re-entry is
/// fatal unless annotated as a truncation point, and the depth cap, which bounds struct nesting
/// and resets across a list hop.</summary>
internal static class SubFieldReflection
{
    // Walks only what getterInterface declares or inherits, never a more-derived sibling interface, so
    // a union's leaf members are unreachable from the base alone; LoquiUnions closes that gap below.
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
            var spec = GetSubFieldInfo(ReflectedTypes.MostDerived(group), game, inner, depth + 1, logger);
            if (spec != null) result.Add(spec);
        }

        if (LoquiUnions.TryGetUnion(getterInterface, game) is { } union)
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
            { } leaf => ProjectSubField(prop, nullable, leaf, game),
            null when ReflectedTypes.IsListType(core, out var elementType) =>
                ListLeaves.BuildList(prop, elementType, game, path, logger),
            null when ReflectedTypes.IsLoquiInterface(core) => StructLeaves.BuildStruct(prop, core, game, path, depth, logger),
            _ => SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "sub-field"),
        };
    }

    /// <summary>One classified leaf as the member it was reached as. A nullable member genuinely can
    /// be absent-meaning-null, so it reads as null rather than as a default it never had.</summary>
    internal static SubFieldSpec ProjectSubField(PropertyInfo prop, bool nullable, LeafSpec leaf, GameReflection game)
    {
        return new(prop.Name, leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumMembers,
            AllowsNull: leaf.AllowsNull,
            SiblingsInUse: game.Annotations.SiblingsInUseFor(prop),
            Default: nullable ? null : leaf.Default);
    }
}
