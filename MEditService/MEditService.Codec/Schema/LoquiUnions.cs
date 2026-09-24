using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Loqui;
using Microsoft.Extensions.Logging;

namespace MEditService.Codec.Schema;

/// <summary>The one mechanism for a Loqui base with concrete leaves under it, inside a record,
/// generic (OMOD) or the record class itself (GMST, GLOB, DMGT): each leaf's members unioned,
/// plus the document's own discriminator.</summary>
public static class LoquiUnions
{
    // Every class Loqui registers, filed under its whole base chain so a two-level chain is found
    // too, a generic base by its definition. An unregistered subclass (DeletedObjectModification)
    // is no leaf: the codec cannot build it either.
    private static readonly ConcurrentDictionary<Assembly, ILookup<Type, (Type Class, Type Getter)>> LeavesByBase = new();

    private static ILookup<Type, (Type Class, Type Getter)> IndexLeavesByBase(Assembly assembly) =>
        assembly.GetTypes()
            .Where(t => t is { IsClass: true, IsAbstract: false } && typeof(ILoquiObjectSetter).IsAssignableFrom(t))
            .SelectMany(t => ReflectedTypes.GetOwnGetterType(t) is not { } getter
                ? []
                : ReflectedTypes.BaseChain(t).Select(b => (Base: GenericDefinition(b), Leaf: (Class: t, Getter: getter))))
            .ToLookup(e => e.Base, e => e.Leaf);

    private static Type GenericDefinition(Type type) => type.IsGenericType ? type.GetGenericTypeDefinition() : type;

    private static IEnumerable<(Type Class, Type Getter)> LeavesUnder(Type setterType) =>
        LeavesByBase.GetOrAdd(setterType.Assembly, IndexLeavesByBase)[GenericDefinition(setterType)];

    // A concrete class with no subclass is not a union: it would be its own only leaf. Mutagen
    // builds a bare ScriptProperty for a property of type None.
    private static bool IsUnionBase(Type setterType, int leafCount) =>
        leafCount > (setterType.IsAbstract ? 0 : 1);

    /// <summary>Whether this base expands to leaves at all, asked of an annotation that claims it
    /// does. Blind to the exclusion table, which is what such a row would set.</summary>
    internal static bool IsUnionBase(Type setterType) => IsUnionBase(setterType, LeavesUnder(setterType).Count());

    // ExcludedUnions gates here, not only in IsExcludedUnionColumn: BuildSubSchema's recursive walk
    // reaches a type with no memory of which field led to it.
    internal static LoquiUnion? TryGetUnion(Type getterInterface, GameReflection game)
    {
        if (ReflectedTypes.GetSetterType(getterInterface) is not { } setterType) return null;
        if (game.Annotations.IsExcludedUnion(setterType)) return null;
        // A generic leaf's getter is open, its own members never mentioning the type argument; its
        // name is the codec's, closed by the arguments the owner's base carries.
        var typeArguments = getterInterface.GetGenericArguments();
        // A concrete base is its own last leaf: a leaf is recognised by IsInstanceOfType, first
        // match wins, and the base would otherwise claim every object of its subclasses.
        var leaves = LeavesUnder(setterType)
            .OrderBy(leaf => leaf.Class == setterType)
            .Select(leaf => (leaf.Getter, ReflectedTypes.DocumentTypeName(leaf.Class, typeArguments)))
            .ToList();
        return IsUnionBase(setterType, leaves.Count) ? new LoquiUnion(setterType, leaves) : null;
    }

    /// <summary>The class itself when concrete, else the first concrete class under it; null when
    /// nothing concrete exists.</summary>
    internal static Type? ConcreteUnder(Type setterType) =>
        !setterType.IsAbstract ? setterType : LeavesUnder(setterType).Select(l => l.Class).FirstOrDefault();

    /// <summary>A base and the concrete classes under it. The base travels with the leaves because
    /// the discriminator's labels are the leaf names read relative to it (<see cref="LeafLabel"/>).</summary>
    internal sealed record LoquiUnion(Type SetterType, List<(Type GetterType, string ClassName)> Leaves);

    /// <summary>The record classes sharing one table, as a union over their nearest common base.</summary>
    internal static LoquiUnion RecordUnion(IEnumerable<Type> siblingGetterTypes)
    {
        var leaves = siblingGetterTypes
            .Select(g => (Getter: g, Setter: ReflectedTypes.GetSetterType(g)
                ?? throw new InvalidOperationException($"Expected '{g.Name}' to have a setter type.")))
            .ToList();
        var common = leaves
            .Select(l => ReflectedTypes.BaseChain(l.Setter).ToList())
            .Aggregate((chain, next) => [.. chain.Where(next.Contains)])[0];
        return new LoquiUnion(common, [.. leaves.Select(l => (l.Getter, ReflectedTypes.DocumentTypeName(l.Setter)))]);
    }

    // Members grouped by name across leaves: one leaf's becomes its field; a shared name becomes one
    // field, carrying a variant per leaf when the leaves disagree on its shape. The base's own
    // members BuildSubSchema reached are excluded.
    internal static List<SubFieldSpec> BuildUnionLeafFields(
        Type getterInterface,
        LoquiUnion union,
        GameReflection game,
        Type[] path,
        ILogger logger)
    {
        var baseMemberNames = ReflectedTypes.GetAllInterfaceProperties(getterInterface)
            .Where(p => !game.Annotations.IsExcludedMember(p))
            .Select(p => p.Name)
            .ToHashSet(StringComparer.Ordinal);

        // A leaf Enter declines is left out entirely, members and discriminator value both, which is
        // how a documented truncation ends.
        var reached = new List<(Type GetterType, string ClassName)>();
        var leaves = new List<(string ClassName, IReadOnlyList<SubFieldSpec> Members)>();
        foreach (var (getterType, className) in union.Leaves)
        {
            var leafPath = getterType == getterInterface ? path : SubFieldReflection.Enter(path, getterType, game);
            if (leafPath == null) continue;
            var members = ReflectedTypes.GetAllInterfaceProperties(getterType)
                .Where(p => !game.Annotations.IsExcludedMember(p) && !baseMemberNames.Contains(p.Name))
                .GroupBy(p => p.Name, StringComparer.Ordinal)
                .Select(ReflectedTypes.MostDerived)
                .Select(p => SubFieldReflection.GetSubFieldInfo(p, game, leafPath, logger))
                .OfType<SubFieldSpec>()
                .ToList();
            reached.Add((getterType, className));
            leaves.Add((className, members));
        }

        var result = UnionMembers(leaves, s => s.Name, s => s.ToFieldMetadata())
            .Select(m => m.First with { AllowsNull = true, Variants = m.Variants })
            .ToList();
        result.Add(BuildUnionDiscriminatorField(union with { Leaves = reached }));
        return result;
    }

    /// <summary>The record classes sharing one table as one union: the base's columns, then the
    /// leaves' own through the same fold, and first the discriminator column, since the table's
    /// document names its class first.</summary>
    internal static List<ColumnSpec> BuildUnionColumns(LoquiUnion union, GameReflection game, ILogger logger)
    {
        var ownGetterType = ReflectedTypes.GetOwnGetterType(union.SetterType)
            ?? throw new InvalidOperationException($"Expected '{union.SetterType.Name}' to have its own getter type.");
        var columns = ColumnReflection.ReflectColumns(ownGetterType, game, logger);
        var baseNames = columns.Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        var leaves = union.Leaves
            .Select(l => (l.ClassName, (IReadOnlyList<ColumnSpec>)[.. ColumnReflection.ReflectColumns(l.GetterType, game, logger).Where(c => !baseNames.Contains(c.Name))]))
            .ToList();

        columns.AddRange(UnionMembers(leaves, c => c.Name, c => c.ToFieldMetadata())
            .Select(m => m.First with
            {
                Field = m.First.Field with
                {
                    AllowsNull = true,
                    Variants = m.Variants?.ToDictionary(v => v.Key, v => v.Value.Field, StringComparer.Ordinal),
                },
                // A column the record classes shape differently, or one only some of them declare,
                // has no default a view could put back for the rest.
                ViewDefaultLiteral = m.Variants == null ? m.First.ViewDefaultLiteral : null,
            }));

        var discriminator = BuildUnionDiscriminatorField(union);
        columns.Insert(0, new ColumnSpec(discriminator, discriminator.Name, "VARCHAR"));
        return columns;
    }

    // One field per member name, shaped as its first leaf's, with a variant per leaf wherever the
    // leaves disagree or one lacks it. Shape is the whole wire description, compared as JSON since
    // FieldMetadata's collections compare by reference.
    private static IEnumerable<(T First, IReadOnlyDictionary<string, T>? Variants)> UnionMembers<T>(
        IReadOnlyList<(string ClassName, IReadOnlyList<T> Members)> leaves, Func<T, string> name, Func<T, FieldMetadata> shape)
    {
        var byName = leaves
            .SelectMany(l => l.Members.Select(m => (l.ClassName, Member: m)))
            .GroupBy(d => name(d.Member), StringComparer.Ordinal);
        foreach (var group in byName)
        {
            var declaring = group.ToList();
            var alike = declaring.Count == leaves.Count
                && declaring.Select(d => JsonSerializer.Serialize(shape(d.Member))).Distinct(StringComparer.Ordinal).Count() == 1;
            yield return (declaring[0].Member, alike ? null : declaring.ToDictionary(d => d.ClassName, d => d.Member, StringComparer.Ordinal));
        }
    }

    /// <summary>The document's own discriminator member: the first key of every union element the
    /// codec writes, naming the leaf class.</summary>
    public const string UnionTypeDiscriminator = "MutagenObjectType";

    // An enum, so the editor's enum-leaf rule renders it and the class names stay wire tokens
    // LeafLabel labels. Setting it switches the object's leaf; see editor-fields.md, A field of several kinds.
    internal static SubFieldSpec BuildUnionDiscriminatorField(LoquiUnion union) =>
        new(UnionTypeDiscriminator, "enum", LeafSpec.NoFormKeyTypes,
            [.. union.Leaves.Select(l => new EnumMember(
                l.ClassName, Label: LeafLabel.For(ReflectedTypes.LeafTypeName(union.SetterType), LeafLabel.ClassWord(l.ClassName))))],
            AllowsNull: true, DisplayLabel: UnionTypeDiscriminatorLabel, IsDiscriminator: true);

    internal const string UnionTypeDiscriminatorLabel = "Kind";
}
