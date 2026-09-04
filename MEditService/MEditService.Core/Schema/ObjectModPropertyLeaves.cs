using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>The one base getter interface whose real per-element payload lives entirely on named
/// sibling leaf interfaces it never inherits from, reachable only through a hand-picked table because
/// the base is generic and carries no reflectively enumerable class type of its own. Distinct from
/// <see cref="LoquiUnions"/>, which discovers its leaves by reflection alone.</summary>
internal static class ObjectModPropertyLeaves
{
    // Hardcoded to these seven names, not discovered by scanning the assembly for anything else
    // shaped like this: IAObjectModPropertyGetter<T> is, today, the only base Getter interface in
    // the schema whose real per-element payload lives entirely on named sibling leaves it never
    // inherits from (confirmed against the real ObjectMod*Property_Generated.cs sources — the one
    // other generic Getter interface in the Fallout4 assembly, IObjectTemplateGetter<T>, has no
    // such siblings at all). Building a general "discover a base's leaf siblings" mechanism here
    // would be machinery for a second consumer that doesn't exist yet; if one turns up, a general
    // version can be lifted out then, against two real call sites instead of one
    // imagined one.
    //
    // Each leaf is paired with Mutagen's own ObjectModProperty.ValueType member name (verified
    // against Mutagen.Bethesda.Fallout4/Records/Common Subrecords/ObjectModProperty.cs — Int=0,
    // Float=1, Bool=2, String=3, FormIdInt=4, Enum=5, FormIdFloat=6, reordered here to line up
    // with the getter-interface list rather than the enum's own ordinal order) — the write-side
    // discriminator (see ResolveObjectModPropertyConcreteType below), spelled the same way the
    // read side exposes it (BuildObjectModPropertyLeafFields' `value_type`), not
    // a second scheme. Bare strings, not a reference to one game's enum type, for the same reason
    // the interface names are strings: this stays game-generic (Starfield's own ValueType enum
    // carries the same seven members under its own namespace).
    private static readonly (string InterfaceName, string ValueTypeName)[] LeafInterfaces =
    [
        ("IObjectModIntPropertyGetter`1", "Int"),
        ("IObjectModFloatPropertyGetter`1", "Float"),
        ("IObjectModBoolPropertyGetter`1", "Bool"),
        ("IObjectModStringPropertyGetter`1", "String"),
        ("IObjectModEnumPropertyGetter`1", "Enum"),
        ("IObjectModFormLinkIntPropertyGetter`1", "FormIdInt"),
        ("IObjectModFormLinkFloatPropertyGetter`1", "FormIdFloat"),
    ];

    internal static bool IsObjectModPropertyBase(Type getterInterface) =>
        getterInterface.IsGenericType &&
        getterInterface.GetGenericTypeDefinition().Name == "IAObjectModPropertyGetter`1";

    // Builds the sparse union of the seven leaves' own members (never Property/Step — those are
    // already reached by SubFieldReflection.BuildSubSchema's ordinary walk). Resolved by name off getterInterface's own
    // namespace/assembly rather than a compile-time reference to one game's types, so this still
    // works whichever category's Mutagen assembly is actually loaded (Starfield ships the exact
    // same seven type names under its own namespace).
    //
    // The leaves' own declared members are grouped by name. A name every
    // declaring leaf agrees on the CLR type for becomes one typed, sparse sub-field (null on a
    // leaf that lacks it) — `record` (FormLink, FormLinkInt/FormLinkFloat only) and
    // `enum_int_value` (uint, Enum only). A name whose declaring leaves disagree on type becomes
    // one text field via the same WidenedLeaf.FormatWidenedValue the scalar-widen rung already uses —
    // `value` (uint/float/bool/string across six leaves), `value2` (uint/float/bool across
    // three), `function_type` (four distinct FunctionType CLR types across all seven).
    //
    // Every result here carries a real Apply. BuildTypedLeafUnionField reuses the
    // ordinary per-field write routing every other sub-field gets. Its widened
    // sibling gets a dedicated applier that resolves the already-constructed concrete object's own
    // declared property type at write time rather than assuming one — the read side structurally
    // cannot, since nothing has committed to a concrete type yet there.
    // A plain `result.Add` below also gives the element a `value_type` discriminator sub-field —
    // synthesized here, not one of the seven leaves' own declared members — which is what
    // ListLeaves.ApplyListJson's discriminator-driven concrete-type resolution reads.
    internal static List<SubFieldSpec> BuildObjectModPropertyLeafFields(
        Type baseGetterInterface, GameReflection game, ILogger logger)
    {
        var ns = baseGetterInterface.Namespace;
        var asm = baseGetterInterface.Assembly;
        var args = baseGetterInterface.GetGenericArguments();

        var leaves = new List<(Type LeafType, string ValueTypeName)>();
        foreach (var (interfaceName, valueTypeName) in LeafInterfaces)
        {
            var open = asm.GetType($"{ns}.{interfaceName}");
            if (open == null)
            {
                // Same convention as ModHeaderSchema.BuildHeaderSchema's own lookup-came-up-empty branches: this
                // runs once per category at schema-build time, not per record, so it's not the
                // per-call accessor-lambda case MEditService/CLAUDE.md's logging section carves
                // silence out for — never seen missing in a real category, but a category whose
                // Mutagen assembly renamed or dropped one of these seven leaves should say so
                // rather than silently lose that leaf's fields.
                logger.LogWarning(
                    "No {LeafName} type found in {Assembly}; OMOD Properties element omits that leaf's fields",
                    interfaceName, asm.GetName().Name);
                continue;
            }
            leaves.Add((open.MakeGenericType(args), valueTypeName));
        }

        var members = leaves
            .SelectMany(leaf => leaf.LeafType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => !game.Annotations.IsExcludedMember(p))
                .Select(p => (LeafType: leaf.LeafType, Prop: p)))
            .GroupBy(m => ReflectedTypes.ToSnakeCase(m.Prop.Name), StringComparer.OrdinalIgnoreCase);

        var result = new List<SubFieldSpec>();
        foreach (var group in members)
        {
            var list = group.ToList();
            var distinctTypes = list
                .Select(m => Nullable.GetUnderlyingType(m.Prop.PropertyType) ?? m.Prop.PropertyType)
                .Distinct()
                .ToList();

            result.Add(distinctTypes.Count == 1
                ? BuildTypedLeafUnionField(group.Key, list, game, logger)
                : BuildWidenedLeafUnionField(group.Key, list, logger));
        }

        result.Add(BuildObjectModValueTypeField(leaves));
        return result;
    }

    private const string ObjectModValueTypeDiscriminator = "value_type";

    // The write-side discriminator — which of the seven leaves a Properties element's own
    // JSON should construct. Read: classifies the object's already-concrete runtime type the exact
    // same way every Extract above does (`leafType.IsInstanceOfType`); nothing new is derived here,
    // only exposed. Read-only, deliberately — this cannot be applied to an *already-constructed*
    // object the way every other sub-field can, because it is what decides which concrete type gets
    // constructed in the first place. ListLeaves.ApplyListJson (ResolveObjectModPropertyConcreteType) reads it
    // directly off the incoming JsonElement, before any object exists to apply anything onto.
    private static SubFieldSpec BuildObjectModValueTypeField(List<(Type LeafType, string ValueTypeName)> leaves)
    {
        object? Extract(object obj)
        {
            foreach (var (leafType, valueTypeName) in leaves)
                if (leafType.IsInstanceOfType(obj)) return valueTypeName;
            return null;
        }

        return new(ObjectModValueTypeDiscriminator, "string", LeafSpec.NoFormKeyTypes,
            [.. leaves.Select(l => new EnumMember(l.ValueTypeName))], Extract,
            Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.DiscriminatorReason), AllowsNull: true,
            IsDiscriminator: true);
    }

    private static SubFieldSpec BuildTypedLeafUnionField(
        string colName, List<(Type LeafType, PropertyInfo Prop)> members,
        GameReflection game, ILogger logger)
    {
        var core = Nullable.GetUnderlyingType(members[0].Prop.PropertyType) ?? members[0].Prop.PropertyType;
        var perLeaf = members
            .Select(m => (m.LeafType, Leaf: LeafClassification.ClassifyLeaf(m.Prop, core, game)!))
            .ToList();
        var rep = perLeaf[0].Leaf;
        // Every member in this group shares one CLR property name (that agreement is what put it
        // in the typed union rather than the widened one below), so one applier — resolved off
        // whichever concrete leaf ListLeaves.ApplyListJson already constructed — covers every leaf.
        var pName = members[0].Prop.Name;

        object? Extract(object obj)
        {
            foreach (var (leafType, leaf) in perLeaf)
                if (leafType.IsInstanceOfType(obj)) return leaf.Get(obj);
            return null;
        }

        // The same LeafWriters.RouteWriter every other sub-field goes through — it resolves the
        // property off the target's own runtime type and answers ApplyOutcome.PropertyNotFound when
        // that type doesn't declare it, which SubFieldValues.ApplySubFields treats as a silent
        // no-op, exactly what a leaf that lacks this member needs.
        var apply = LeafWriters.RouteWriter<object>(rep, core, pName, nullable: true, logger);

        return new(colName, rep.ApiType, rep.ValidFormKeyTypes, rep.EnumMembers, Extract,
            apply,
            AllowsNull: true);
    }

    private static SubFieldSpec BuildWidenedLeafUnionField(
        string colName, List<(Type LeafType, PropertyInfo Prop)> members, ILogger logger)
    {
        var getters = members.Select(m => (m.LeafType, Get: ReflectedTypes.SubGetter(m.Prop))).ToList();
        var pName = members[0].Prop.Name;

        object? Extract(object obj)
        {
            foreach (var (leafType, get) in getters)
                if (leafType.IsInstanceOfType(obj)) return WidenedLeaf.FormatWidenedValue(get(obj));
            return null;
        }

        // Unlike the typed union above, these members disagree on CLR type across leaves —
        // that disagreement is why they are widened to text on read in the first place. Apply
        // therefore cannot share one converter the way LeafWriters.MakeApplier's callers normally do; instead
        // it resolves the target property's own declared type at write time, off whichever
        // concrete leaf ListLeaves.ApplyListJson already constructed, and converts into *that*.
        return new(colName, "string", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Extract, Apply: LeafWrite.Writable(WidenedLeaf.MakeWidenedApplier(pName, logger)), AllowsNull: true);
    }

    // Reads the `value_type` discriminator BuildObjectModValueTypeField exposes on read and maps it
    // back to the one leaf getter interface that owns it (LeafInterfaces — the exact same
    // table BuildObjectModPropertyLeafFields resolves from, so read and write cannot name the seven
    // leaves differently), then to that interface's own concrete Setter class (ReflectedTypes.GetSetterType) closed
    // over elemConcreteType's own T. Null for any reason — missing/unrecognized discriminator, a
    // leaf interface or setter type that no longer resolves — is exactly the caller's one signal to
    // refuse rather than guess.
    internal static Type? ResolveObjectModPropertyConcreteType(Type elemConcreteType, JsonElement elem)
    {
        if (!elem.TryGetProperty(ObjectModValueTypeDiscriminator, out var vt) || vt.ValueKind != JsonValueKind.String)
            return null;

        var match = Array.Find(LeafInterfaces, l => l.ValueTypeName == vt.GetString());
        if (match.InterfaceName == null) return null;

        var typeArgs = elemConcreteType.GetGenericArguments();
        var getterOpen = elemConcreteType.Assembly.GetType($"{elemConcreteType.Namespace}.{match.InterfaceName}");
        if (getterOpen == null) return null;

        // ReflectedTypes.GetSetterType's own ClassType field answers with the *open* generic Setter class (e.g.
        // ObjectModIntProperty<T>, T unbound) even off a closed getter interface — confirmed against
        // real Fallout4 types, not assumed — so closing it over elemConcreteType's own T is this
        // method's own job, not ReflectedTypes.GetSetterType's.
        var setterType = ReflectedTypes.GetSetterType(getterOpen.MakeGenericType(typeArgs));
        if (setterType is not { IsAbstract: false }) return null;
        return setterType.IsGenericTypeDefinition ? setterType.MakeGenericType(typeArgs) : setterType;
    }
}
