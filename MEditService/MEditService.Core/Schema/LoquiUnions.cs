using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A Loqui base whose per-subclass data lives on the classes under it: the union of each
/// leaf's members plus the document's own discriminator. A concrete base is its last leaf, keeping the
/// discriminator's first member stable.</summary>
internal static class LoquiUnions
{
    // Kept separate from ObjectModPropertyLeaves' hand-picked table: two different discovery
    // mechanisms, not one abstraction.

    // Every concrete class under a base, filed under its whole base chain so a two-level chain is
    // found like a one-level one. The assembly is scanned once per schema build. A leaf's name is
    // the one the codec writes for it.
    private static readonly ConcurrentDictionary<Assembly, ILookup<Type, (Type GetterType, string ClassName)>> LeavesByBase = new();

    private static ILookup<Type, (Type GetterType, string ClassName)> IndexLeavesByBase(Assembly assembly) =>
        assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && !t.ContainsGenericParameters)
            .Select(t => (Leaf: t, Getter: ReflectedTypes.GetOwnGetterType(t)))
            .Where(l => l.Getter != null)
            .SelectMany(l => ReflectedTypes.BaseChain(l.Leaf).Select(b => (Base: b, Leaf: (l.Getter!, ReflectedTypes.DocumentTypeName(l.Leaf)))))
            .ToLookup(e => e.Base, e => e.Leaf);

    // A concrete class with no subclass is not a union: it would be its own only leaf. Mutagen
    // builds a bare ScriptProperty for a property of type None.
    private static bool IsUnionBase(Type setterType, List<(Type GetterType, string ClassName)> leaves) =>
        leaves.Count > (setterType.IsAbstract ? 0 : 1);

    // ExcludedUnions gates here, not only in IsExcludedUnionColumn: BuildSubSchema's recursive walk
    // reaches a type with no memory of which field led to it. OMOD's base never arrives; its caller
    // checks IsObjectModPropertyBase first.
    internal static LoquiUnion? TryGetUnion(Type getterInterface, GameReflection game)
    {
        if (ReflectedTypes.GetSetterType(getterInterface) is not { } setterType) return null;
        if (game.Annotations.IsExcludedUnion(setterType)) return null;
        // A concrete base is its own last leaf: a leaf is recognised by IsInstanceOfType, first
        // match wins, and the base would otherwise claim every object of its subclasses.
        var leaves = LeavesByBase.GetOrAdd(setterType.Assembly, IndexLeavesByBase)[setterType]
            .OrderBy(l => l.GetterType == getterInterface)
            .ToList();
        return IsUnionBase(setterType, leaves) ? new LoquiUnion(setterType, leaves) : null;
    }

    /// <summary>A base and the concrete classes under it. The base travels with the leaves because
    /// the discriminator's labels are the leaf names read relative to it (<see cref="LeafLabel"/>).</summary>
    internal sealed record LoquiUnion(Type SetterType, List<(Type GetterType, string ClassName)> Leaves);

    /// <summary>The record classes sharing one table, as a union over their nearest common base.</summary>
    internal static LoquiUnion RecordUnion(IEnumerable<Type> siblingGetterTypes)
    {
        var leaves = siblingGetterTypes
            .Select(g => (Getter: g, Setter: ReflectedTypes.GetSetterType(g)!))
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
        int depth,
        ILogger logger)
    {
        var baseMemberNames = ReflectedTypes.GetAllInterfaceProperties(getterInterface)
            .Where(p => !game.Annotations.IsExcludedMember(p))
            .Select(p => p.Name)
            .ToHashSet(StringComparer.Ordinal);

        // A leaf Enter declines is left out entirely, members and discriminator value both, which is
        // how a documented truncation ends.
        var leaves = new List<UnionLeafWalk>();
        foreach (var (getterType, className) in union.Leaves)
        {
            var leafPath = getterType == getterInterface ? path : SubFieldReflection.Enter(path, getterType, game);
            if (leafPath == null) continue;
            var members = ReflectedTypes.GetAllInterfaceProperties(getterType)
                .Where(p => !game.Annotations.IsExcludedMember(p) && !baseMemberNames.Contains(p.Name))
                .GroupBy(p => p.Name, StringComparer.Ordinal)
                .ToDictionary(
                    g => g.Key,
                    g => g.Aggregate((best, cand) =>
                        best.DeclaringType!.IsAssignableFrom(cand.DeclaringType!) ? cand : best),
                    StringComparer.Ordinal);
            leaves.Add(new(getterType, className, leafPath, members));
        }
        union = union with { Leaves = [.. leaves.Select(l => (l.GetterType, l.ClassName))] };

        var result = new List<SubFieldSpec>();
        foreach (var name in leaves.SelectMany(l => l.Members.Keys).Distinct(StringComparer.Ordinal))
        {
            var declaring = leaves
                .Where(l => l.Members.ContainsKey(name))
                .Select(l => (Leaf: l, Spec: SubFieldReflection.GetSubFieldInfo(l.Members[name], game, l.Path, depth, logger)))
                .Where(d => d.Spec != null)
                .Select(d => (d.Leaf, Spec: d.Spec!))
                .ToList();
            if (declaring.Count > 0) result.Add(BuildUnionMemberField(declaring));
        }

        result.Add(BuildUnionDiscriminatorField(union));
        return result;
    }

    private sealed record UnionLeafWalk(
        Type GetterType, string ClassName, Type[] Path, Dictionary<string, PropertyInfo> Members);

    // Shape is ApiType, element type and sub-field count: enough to tell shapes apart without
    // re-deriving the dispatch.
    private static (string, string?, int, int) ShapeKey(SubFieldSpec spec) =>
        (spec.ApiType, spec.ElementSpec?.ApiType, spec.SubFields?.Count ?? -1, spec.ElementSpec?.SubFields?.Count ?? -1);

    // One field whose own shape is the first declaring leaf's; when the leaves disagree, every leaf's
    // shape rides along as that leaf's variant. Written through whichever declaring leaf the object
    // is, any other answering PropertyNotFound, so a resend after a leaf switch drops the outgoing
    // leaf's member.
    private static SubFieldSpec BuildUnionMemberField(List<(UnionLeafWalk Leaf, SubFieldSpec Spec)> declaring)
    {
        var rep = declaring[0].Spec;
        var variants = declaring.Select(d => ShapeKey(d.Spec)).Distinct().Count() > 1
            ? declaring.ToDictionary(d => d.Leaf.ClassName, d => d.Spec, StringComparer.Ordinal)
            : null;

        var apply = rep.Apply.Writer == null
            ? rep.Apply
            : LeafWrite.Writable<object>((obj, val) =>
            {
                foreach (var (leaf, spec) in declaring)
                {
                    if (!leaf.GetterType.IsInstanceOfType(obj)) continue;
                    return spec.Apply.Writer is { } write ? write(obj, val) : ApplyOutcome.SubFieldReadOnly;
                }
                return ApplyOutcome.PropertyNotFound;
            });

        return rep with { Apply = apply, AllowsNull = true, Variants = variants };
    }

    /// <summary>The document's own discriminator member: the first key of every union element the
    /// codec writes, naming the leaf class.</summary>
    internal const string UnionTypeDiscriminator = "MutagenObjectType";

    // An enum, so the editor's enum-leaf rule renders it and the class names stay wire tokens
    // LeafLabel labels. Changing it is an ordinary edit of the enclosing object; see
    // docs/specs/medit-record-editor.md.
    internal static SubFieldSpec BuildUnionDiscriminatorField(LoquiUnion union) =>
        new(UnionTypeDiscriminator, "enum", LeafSpec.NoFormKeyTypes,
            [.. union.Leaves.Select(l => new EnumMember(
                l.ClassName, Label: LeafLabel.For(union.SetterType.Name, LeafLabel.ClassWord(l.ClassName))))],
            Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.DiscriminatorReason), AllowsNull: true,
            DisplayLabel: UnionTypeDiscriminatorLabel, IsDiscriminator: true);

    internal const string UnionTypeDiscriminatorLabel = "Kind";

    // Null is the caller's signal to refuse rather than guess. An O(1) namespace lookup, not an
    // IndexLeavesByBase-style scan of 12,914 types: this is the write path, called per element,
    // uncached. IsAssignableFrom still refuses an unrelated type.
    internal static Type? ResolveUnionConcreteType(Type setterType, JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object) return null;
        if (!json.TryGetProperty(UnionTypeDiscriminator, out var dt) || dt.ValueKind != JsonValueKind.String)
            return null;

        var name = dt.GetString();
        if (string.IsNullOrEmpty(name)) return null;

        var candidate = setterType.Assembly.GetType($"{setterType.Namespace}.{name}");
        return candidate is { IsAbstract: false } && setterType.IsAssignableFrom(candidate)
            ? candidate
            : null;
    }
}
