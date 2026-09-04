using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A Loqui base whose real per-subclass data lives on the concrete classes that inherit
/// from it — Mutagen's abstract "A&lt;Name&gt;" convention (ANpcLevel: NpcLevel/PcLevelMult;
/// AQuestAlias: QuestReferenceAlias/QuestLocationAlias/QuestCollectionAlias), and equally a concrete
/// base with subclasses (ScriptProperty and its fourteen leaves, itself one more leaf). Presents the
/// sparse union of every leaf's own members plus a discriminator naming which leaf an object is. The
/// leaves are ordered so a concrete base is its own LAST leaf, which is what keeps the
/// discriminator's first member — and so an array_add default — stable.</summary>
/// <remarks>
/// <para>Leaves are discovered by reflection, not from a table: every union here backs its base
/// getter interface with an ordinary non-generic class (ANpcLevel_Registration.ClassType,
/// FieldCount == 0), so scanning assembly.GetTypes() for what is and is not abstract reaches them
/// the same way SchemaReflector.BuildForCategory's own top-level loop reaches every schema type.
/// <see cref="ObjectModPropertyLeaves"/> solves the same "a plain interface walk from the base alone
/// never reaches it" shape narrowly for OMOD, whose generic-closed sibling interfaces have no
/// reflectively enumerable ClassType and so need a hand-picked table. The two stay separate rather
/// than forced into one abstraction over two genuinely different discovery mechanisms.</para>
///
/// <para>Each leaf's member set is built with <see cref="SubFieldReflection.GetSubFieldInfo"/> — the
/// same per-property dispatch every ordinary sub-field goes through (nested Loqui structs, lists,
/// vector structs, and every scalar/enum/formlink/string shape), not the narrower four-shape
/// <see cref="LeafClassification.ClassifyLeaf"/> set OMOD's leaves need: AQuestAlias's leaves are
/// not all scalar (QuestReferenceAlias's "Fill Type" is itself several nested Loqui structs, and two
/// of its three leaves share a list-typed Conditions member). A member whose declaring leaves
/// disagree on shape becomes one field per shape (<see cref="BuildUnionMemberFields"/>) — the same
/// one-column-per-shape rule <see cref="SiblingColumns.SplitNonScalarByShape"/> follows for a
/// differently-shaped same-named column.</para>
/// </remarks>
internal static class LoquiUnions
{
    // Every concrete class in the same assembly under a base, paired with its own getter interface
    // and its own class Name (the discriminator value — see BuildUnionDiscriminatorField). Filed
    // under the whole base chain, so a two-level chain (APerkEffect -> APerkEntryPointEffect ->
    // PerkEntryPointModifyValue) is found the same way a one-level one (ANpcLevel -> NpcLevel) is.
    // Every base is asked once per schema build for every Loqui struct the walk reaches, so the
    // assembly is scanned once and each concrete class filed under its whole base chain.
    private static readonly ConcurrentDictionary<Assembly, ILookup<Type, (Type GetterType, string ClassName)>> LeavesByBase = new();

    private static ILookup<Type, (Type GetterType, string ClassName)> IndexLeavesByBase(Assembly assembly) =>
        assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && !t.ContainsGenericParameters)
            .Select(t => (Leaf: t, Getter: ReflectedTypes.GetOwnGetterType(t)))
            .Where(l => l.Getter != null)
            .SelectMany(l => ReflectedTypes.BaseChain(l.Leaf).Select(b => (Base: b, Leaf: (l.Getter!, l.Leaf.Name))))
            .ToLookup(e => e.Base, e => e.Leaf);

    // A base with something under it: every concrete class assignable to it, itself included when
    // it is concrete (a bare ScriptProperty is what Mutagen builds for a property of type None).
    // A concrete class with no subclass is not a union — it would be its own only leaf.
    private static bool IsUnionBase(Type setterType, List<(Type GetterType, string ClassName)> leaves) =>
        leaves.Count > (setterType.IsAbstract ? 0 : 1);

    // getterInterface qualifies when its own Setter type (ReflectedTypes.GetSetterType) is a union base
    // (IsUnionBase) outside SchemaAnnotations.ExcludedUnions (Condition/ConditionData and
    // AVirtualMachineAdapter — structurally identical to ANpcLevel/AQuestAlias, but owned by their
    // dedicated sections: IsConditionListField and SchemaRefusals.IsExcludedUnionColumn only gate a *named
    // top-level property* in ColumnReflection.ReflectColumns, and SubFieldReflection.BuildSubSchema's recursive walk reaches these
    // types with no memory of which field led to it; and ASceneActionType, whose one leaf cannot
    // be read). OMOD's own IAObjectModPropertyGetter<T> is excluded by SubFieldReflection.BuildSubSchema's own caller order
    // (ObjectModPropertyLeaves.IsObjectModPropertyBase checked first), not by anything here — its Setter type
    // (AObjectModProperty<T>) is abstract too, but this method is simply never reached for it.
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

    /// <summary>A Loqui base and the concrete classes under it, itself last among them when it is
    /// concrete (see <see cref="TryGetUnion"/>). The base travels
    /// with the leaves because the discriminator's own labels are the leaf names read
    /// <i>relative to</i> it (<see cref="LeafLabel"/>).</summary>
    internal sealed record LoquiUnion(Type SetterType, List<(Type GetterType, string ClassName)> Leaves);

    // Builds the sparse union of every leaf's own members, grouped by snake_case name across
    // leaves. A name only one leaf declares (AQuestAlias's own "location"/"external"/"collection",
    // ...) becomes that leaf's own field, gated to read null off any other leaf. A name several
    // leaves declare (AQuestAlias's own "closest_to_alias"/"conditions" are declared by two of its
    // three leaves) becomes one shared field when every declaring leaf's own SubFieldReflection.GetSubFieldInfo shape
    // agrees, or one field per shape when it doesn't (BuildUnionMemberFields). getterInterface's own
    // already-declared members (APerkEffect's own Rank/Priority/Conditions/... — non-zero, unlike
    // ANpcLevel/AQuestAlias) are excluded here: SubFieldReflection.BuildSubSchema's ordinary walk, which
    // runs before this method is called, already reaches those directly off the abstract base itself.
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

        // The base is already on the path when it is its own leaf; every other leaf is entered
        // here. A leaf SubFieldReflection.Enter declines is left out of the union entirely — members and
        // discriminator value both — which is how a documented truncation ends.
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

    /// <summary>One leaf as the walk sees it: its getter, its class name (the discriminator
    /// value), the path its members are walked under, and those members by snake_case name.</summary>
    private sealed record UnionLeafWalk(
        Type GetterType, string ClassName, Type[] Path, Dictionary<string, PropertyInfo> Members);

    // One field when every declaring leaf agrees on shape; one field per shape otherwise, each
    // suffixed by the shape it carries (ScriptProperty's Data is an int on one leaf, a float on
    // another, a list of strings on a third: data_int, data_float, data_string_array). Shape is
    // ApiType plus element type plus sub-field count — enough to tell a struct from a scalar, an
    // int list from a float list, or two structs with different member sets apart, without
    // re-deriving SubFieldReflection.GetSubFieldInfo's own dispatch.
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

    // A member with one shape across its declaring leaves. Read off whichever of them the object
    // is; written only onto one of them, any other leaf answering PropertyNotFound. That is what
    // lets a resend after a leaf switch, #688, drop the outgoing leaf's own member instead of
    // refusing on it, even where the incoming leaf has a same-named member of another shape.
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
        // rep.Apply resolves its target *property* off the object's own runtime type
        // (LeafWriters.MakeApplier/LeafWriters.ApplyFormLinkJson/the struct- and list-column appliers all do) — but
        // LeafWriters.MakeApplier's own *converter* is bound to rep's declared CLR type, so reusing it
        // unmodified is only safe while every declaring leaf agrees on that type. Real
        // disagreement under an agreeing shape (#643): ALocationTarget's `type` is
        // TargetObjectType on LocationObjectType but LocationTargetRadius.LocationType on
        // LocationFallback — both "enum", so the shape check above passes, and rep's converter
        // would Enum.Parse a non-rep leaf's own valid member name into the wrong enum type and
        // reject it. Scalar/enum/string members that disagree on CLR type get the OMOD widened
        // applier instead (WidenedLeaf.ConvertWidenedJson converts into the target property's own declared
        // type at write time — the exact same fix OMOD's value/value2/function_type already use).
        // FormLink members need nothing: LeafWriters.ApplyFormLinkJson already resolves everything off the
        // runtime object, which is why the differently-closed FormLinks on ANavmeshParent's two
        // leaves (IWorldspaceGetter vs ICellGetter) reuse rep.Apply safely.
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

    /// <summary>Which leaf of the union this object is, as a closed choice among the union's
    /// concrete class names — an <c>enum</c>, so the editor's generic enum-leaf rule renders the
    /// choice with no case of its own, and the names stay wire tokens the user never sees
    /// (<see cref="LeafLabel"/> supplies what is shown). Changing it is an ordinary edit of
    /// the enclosing object, resolved by <see cref="ResolveUnionConcreteType"/>; its own
    /// <c>Apply</c> stays a declared no-write for the reason <see cref="SchemaRefusals.DiscriminatorReason"/>
    /// gives. See docs/specs/medit-record-editor.md, the abstract-union section.</summary>
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

    // Write side: resolves the concrete Setter class named by an incoming JSON object's own
    // concrete_type discriminator. Null for any reason (non-object JSON, a missing/unrecognized
    // discriminator, a leaf whose own concrete class no longer resolves) is the caller's signal to
    // refuse rather than guess — the same contract ObjectModPropertyLeaves.ResolveObjectModPropertyConcreteType already
    // gives ListLeaves.ApplyListJson, extended to StructLeaves.BuildStructColumn's own single-object case too.
    //
    // Deliberately not an IndexLeavesByBase-style full assembly.GetTypes() scan (12,914 types
    // for Mutagen.Bethesda.Fallout4.dll) —
    // fine on the read side, where that runs once per abstract type behind GetSchemas' own cache, but
    // this is the write path, called once per array element (ListLeaves.ApplyListJson/ListLeaves.ApplyListSubFieldJson)
    // with no cache of its own. A leaf's own class always shares its abstract base's namespace (the
    // same fact ObjectModPropertyLeaves.ResolveObjectModPropertyConcreteType's own `asm.GetType($"{ns}.{interfaceName}")`
    // already leans on for OMOD), so the discriminator string names an O(1) lookup directly —
    // IsAssignableFrom still gates it, so a name that resolves to some unrelated same-namespace type
    // is refused exactly the same as an unrecognized one, never silently accepted.
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
