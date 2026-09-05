using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A Loqui base whose per-subclass data lives on the classes under it: the union of each
/// leaf's members plus a discriminator. A concrete base is its last leaf, keeping the
/// discriminator's first member stable.</summary>
internal static class LoquiUnions
{
    // Kept separate from ObjectModPropertyLeaves' hand-picked table: two different discovery
    // mechanisms, not one abstraction.

    // Every concrete class under a base, filed under its whole base chain so a two-level chain is
    // found like a one-level one. The assembly is scanned once per schema build.
    private static readonly ConcurrentDictionary<Assembly, ILookup<Type, (Type GetterType, string ClassName)>> LeavesByBase = new();

    private static ILookup<Type, (Type GetterType, string ClassName)> IndexLeavesByBase(Assembly assembly) =>
        assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && !t.ContainsGenericParameters)
            .Select(t => (Leaf: t, Getter: ReflectedTypes.GetOwnGetterType(t)))
            .Where(l => l.Getter != null)
            .SelectMany(l => ReflectedTypes.BaseChain(l.Leaf).Select(b => (Base: b, Leaf: (l.Getter!, l.Leaf.Name))))
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

    // Members grouped by snake_case name across leaves: one leaf's becomes its field, read null off
    // any other; a shared name becomes one field when shapes agree, one per shape otherwise. The
    // base's own members BuildSubSchema reached are excluded.
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
            .Select(p => ReflectedTypes.ToSnakeCase(p.Name))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        // A leaf Enter declines is left out entirely, members and discriminator value both, which is
        // how a documented truncation ends.
        var leaves = new List<UnionLeafWalk>();
        foreach (var (getterType, className) in union.Leaves)
        {
            var leafPath = getterType == getterInterface ? path : SubFieldReflection.Enter(path, getterType, game);
            if (leafPath == null) continue;
            var members = ReflectedTypes.GetAllInterfaceProperties(getterType)
                .Where(p => !game.Annotations.IsExcludedMember(p) && !baseMemberNames.Contains(ReflectedTypes.ToSnakeCase(p.Name)))
                .GroupBy(p => ReflectedTypes.ToSnakeCase(p.Name), StringComparer.OrdinalIgnoreCase)
                .ToDictionary(
                    g => g.Key,
                    g => g.Aggregate((best, cand) =>
                        best.DeclaringType!.IsAssignableFrom(cand.DeclaringType!) ? cand : best),
                    StringComparer.OrdinalIgnoreCase);
            leaves.Add(new(getterType, className, leafPath, members));
        }
        union = union with { Leaves = [.. leaves.Select(l => (l.GetterType, l.ClassName))] };

        var result = new List<SubFieldSpec>();
        foreach (var name in leaves.SelectMany(l => l.Members.Keys).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var declaring = leaves
                .Where(l => l.Members.ContainsKey(name))
                .Select(l => (Leaf: l, Prop: l.Members[name]))
                .ToList();
            result.AddRange(BuildUnionMemberFields(name, declaring, game, depth, logger));
        }

        var discriminator = BuildUnionDiscriminatorField(union);
        if (result.Any(f => f.Name == discriminator.Name))
        {
            logger.LogWarning(
                "Union {Base}'s own {Discriminator} field name collides with a real leaf " +
                "member; omitting the discriminator rather than silently shadowing that member's data",
                getterInterface.Name, UnionTypeDiscriminator);
        }
        else
        {
            result.Add(discriminator);
        }

        return result;
    }

    private sealed record UnionLeafWalk(
        Type GetterType, string ClassName, Type[] Path, Dictionary<string, PropertyInfo> Members);

    // One field per shape when declaring leaves disagree, each suffixed by shape (data_int,
    // data_float, data_string_array). Shape is ApiType, element type and sub-field count: enough to
    // tell shapes apart without re-deriving the dispatch.
    private static List<SubFieldSpec> BuildUnionMemberFields(
        string colName,
        List<(UnionLeafWalk Leaf, PropertyInfo Prop)> declaring,
        GameReflection game,
        int depth,
        ILogger logger)
    {
        var byShape = declaring
            .Select(d => (d.Leaf, d.Prop, Spec: SubFieldReflection.GetSubFieldInfo(d.Prop, game, d.Leaf.Path, depth, logger)))
            .Where(d => d.Spec != null)
            .Select(d => (d.Leaf, d.Prop, Spec: d.Spec!))
            .GroupBy(d => ShapeKey(d.Spec))
            .ToList();
        var fields = byShape
            .Select(g => BuildUnionShapeField(
                byShape.Count == 1 ? colName : $"{colName}_{ShapeSuffix(g.First().Spec)}", g.ToList(), logger))
            .ToList();

        var ambiguous = fields.GroupBy(f => f.Name).Where(g => g.Count() > 1).Select(g => g.Key).ToList();
        if (ambiguous.Count > 0)
        {
            // Two shapes the suffix cannot tell apart (two structs with different members): neither
            // is exposed rather than one silently shadowing the other (ADR-0026).
            logger.LogWarning(
                "Union member {Member} has shapes the split names cannot distinguish ({Names}); omitted",
                colName, string.Join(", ", ambiguous));
            fields.RemoveAll(f => ambiguous.Contains(f.Name));
        }
        return fields;
    }

    private static (string, string?, int, int) ShapeKey(SubFieldSpec spec) =>
        (spec.ApiType, spec.ElementSpec?.ApiType, spec.SubFields?.Count ?? -1, spec.ElementSpec?.SubFields?.Count ?? -1);

    private static string ShapeSuffix(SubFieldSpec spec) =>
        spec.ElementSpec is { } element ? $"{ReflectedTypes.ToSnakeCase(element.ApiType)}_array" : ReflectedTypes.ToSnakeCase(spec.ApiType);

    // Read off whichever declaring leaf the object is, and written only onto one of them, any other
    // answering PropertyNotFound, so a resend after a leaf switch drops the outgoing leaf's
    // member.
    private static SubFieldSpec BuildUnionShapeField(
        string name,
        List<(UnionLeafWalk Leaf, PropertyInfo Prop, SubFieldSpec Spec)> declaring,
        ILogger logger)
    {
        var rep = declaring[0].Spec;

        object? Extract(object obj)
        {
            foreach (var (leaf, _, spec) in declaring)
                if (leaf.GetterType.IsInstanceOfType(obj)) return spec.Extract(obj);
            return null;
        }
        // MakeApplier's converter is bound to rep's CLR type, unsafe when leaves disagree on it under
        // one shape (ALocationTarget's type is two enums); those get the widened applier. A FormLink
        // needs nothing.
        var distinctClrTypes = declaring
            .Select(d => Nullable.GetUnderlyingType(d.Prop.PropertyType) ?? d.Prop.PropertyType)
            .Distinct()
            .Count();
        var writer = distinctClrTypes > 1 && rep.Apply.Writer != null
            && rep.ApiType is not ("struct" or "array" or "formKey")
            ? WidenedLeaf.MakeWidenedApplier(declaring[0].Prop.Name, logger)
            : rep.Apply.Writer;
        var apply = writer == null
            ? rep.Apply
            : LeafWrite.Writable<object>((obj, val) =>
                declaring.Exists(d => d.Leaf.GetterType.IsInstanceOfType(obj))
                    ? writer(obj, val)
                    : ApplyOutcome.PropertyNotFound);

        return rep with { Name = name, Extract = Extract, Apply = apply, AllowsNull = true };
    }

    internal const string UnionTypeDiscriminator = "concrete_type";

    // An enum, so the editor's enum-leaf rule renders it and the class names stay wire tokens
    // LeafLabel labels. Changing it is an ordinary edit of the enclosing object; see
    // docs/specs/medit-record-editor.md.
    private static SubFieldSpec BuildUnionDiscriminatorField(LoquiUnion union)
    {
        var leaves = union.Leaves;

        object? Extract(object obj)
        {
            foreach (var (getterType, className) in leaves)
                if (getterType.IsInstanceOfType(obj)) return className;
            return null;
        }

        return new(UnionTypeDiscriminator, "enum", LeafSpec.NoFormKeyTypes,
            [.. leaves.Select(l => new EnumMember(
                l.ClassName, Label: LeafLabel.For(union.SetterType.Name, l.ClassName)))],
            Extract,
            Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.DiscriminatorReason), AllowsNull: true,
            DisplayLabel: UnionTypeDiscriminatorLabel, IsDiscriminator: true);
    }

    private const string UnionTypeDiscriminatorLabel = "Kind";

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
