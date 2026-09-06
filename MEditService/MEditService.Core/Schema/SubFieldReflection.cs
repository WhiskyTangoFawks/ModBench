using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>The walk below a record column, bounded by the visited-type path alone: a re-entry is
/// fatal unless an annotated truncation point lies on the loop.</summary>
internal static class SubFieldReflection
{
    // Walks only what getterInterface declares or inherits, never a more-derived sibling interface, so
    // a union's leaf members are unreachable from the base alone; LoquiUnions closes that gap below.
    internal static List<SubFieldSpec> BuildSubSchema(
        Type getterInterface,
        GameReflection game,
        ILogger logger,
        Type[] path)
    {
        if (Enter(path, getterInterface, game) is not { } inner) return [];

        var grouped = ReflectedTypes.GetAllInterfaceProperties(getterInterface)
            .Where(p => !game.Annotations.IsExcludedMember(p))
            .GroupBy(p => p.Name, StringComparer.Ordinal);

        var result = new List<SubFieldSpec>();
        foreach (var group in grouped)
        {
            var spec = GetSubFieldInfo(ReflectedTypes.MostDerived(group), game, inner, logger);
            if (spec != null) result.Add(spec);
        }

        if (LoquiUnions.TryGetUnion(getterInterface, game) is { } union)
            result.AddRange(LoquiUnions.BuildUnionLeafFields(
                getterInterface, union, game, inner, logger));

        return result;
    }

    internal static readonly Type[] RootPath = [];

    // Re-entering a type on the path is a fatal cycle, except through a truncation point the game's
    // format cannot nest past. Each truncation the walk leans on is recorded and validated.
    internal static Type[]? Enter(Type[] path, Type getterInterface, GameReflection game)
    {
        if (game.Annotations.IsCycleTruncation(getterInterface) && path.Any(game.Annotations.IsCycleTruncation))
        {
            game.Observed.AppliedTruncation(getterInterface.Name);
            return null;
        }
        var lastEntry = Array.LastIndexOf(path, getterInterface);
        if (lastEntry < 0) return [.. path, getterInterface];
        var onTheLoop = path.Skip(lastEntry).Where(game.Annotations.IsCycleTruncation).ToList();
        if (onTheLoop.Count > 0)
        {
            foreach (var truncation in onTheLoop) game.Observed.AppliedTruncation(truncation.Name);
            return [.. path, getterInterface];
        }
        throw new InvalidOperationException(
            "SchemaReflector: type cycle in the schema walk: " +
            $"{string.Join(" -> ", path.Append(getterInterface).Select(t => t.Name))}. " +
            "A re-entry the game's own data format cannot nest belongs in SchemaAnnotations.CycleTruncations.");
    }

    internal static SubFieldSpec? GetSubFieldInfo(
        PropertyInfo prop,
        GameReflection game,
        Type[] path,
        ILogger logger)
    {
        var (core, nullable) = ReflectedTypes.CoreOf(prop);

        var spec = LeafClassification.ClassifyLeaf(prop, core, game) switch
        {
            { } leaf => ProjectSubField(prop, nullable, leaf, game),
            null when ReflectedTypes.IsListType(core, out var elementType) =>
                ListLeaves.BuildList(prop, elementType, game, path, logger),
            null when ReflectedTypes.IsLoquiInterface(core) => StructLeaves.BuildStruct(prop, core, game, path, logger),
            _ => SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "member"),
        };

        if (game.Annotations.ReadOnlyReasonFor(prop) is not { } reason) return spec;
        // A member a known defect governs is still named, opaque where the defect is what stopped the
        // walk reaching into it, so it is visible rather than silently dropped.
        return (spec ?? Opaque(prop, core)) with { ReadOnlyReason = reason };
    }

    private static SubFieldSpec Opaque(PropertyInfo prop, Type core) =>
        new(prop.Name, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, SubFields: [],
            AllowsNull: ReflectedTypes.IsNullableMember(prop), LeafTypeName: ReflectedTypes.LeafTypeName(core));

    /// <summary>One classified leaf as the member it was reached as. A nullable member genuinely can
    /// be absent-meaning-null, so it reads as null rather than as a default it never had.</summary>
    internal static SubFieldSpec ProjectSubField(PropertyInfo prop, bool nullable, LeafSpec leaf, GameReflection game)
    {
        return new(prop.Name, leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumMembers,
            // The leaf answers for a form link, whose getter type says nothing; every other kind is
            // the getter's own annotation, which is what tells an unset member from a defaulted one.
            AllowsNull: leaf.AllowsNull || ReflectedTypes.IsNullableMember(prop),
            SiblingsInUse: game.Annotations.SiblingsInUseFor(prop),
            Default: nullable ? null : leaf.Default);
    }
}
