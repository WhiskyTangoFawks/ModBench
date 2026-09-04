using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>The base getter interface whose per-element payload lives on sibling leaf interfaces,
/// reachable through a hand-picked table because the generic base has no class type.
/// <see cref="LoquiUnions"/> discovers its leaves by reflection.</summary>
internal static class ObjectModPropertyLeaves
{
    // Hardcoded: IAObjectModPropertyGetter<T> is the only base whose payload lives on sibling leaves.
    // ValueType names are bare strings to stay game-generic, ordered by the getter list, not the
    // enum's ordinals.
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

    // Resolved by name off getterInterface's namespace so any game's assembly works. A member every
    // declaring leaf types alike becomes one typed sub-field; one they disagree on becomes text via
    // WidenedLeaf. A synthesized value_type discriminator is added last.
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
                // Runs once per category at schema-build time, not per record, so this is not the silent
                // per-call accessor case: a category whose assembly dropped one of the seven should say so.
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

    // Read-only deliberately: it decides which concrete type gets constructed, so it cannot be applied
    // to an already-constructed object; ResolveObjectModPropertyConcreteType reads it off the JSON
    // before any object exists.
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
        // Every member here shares one CLR property name, so one applier resolved off the constructed
        // leaf covers every leaf.
        var pName = members[0].Prop.Name;

        object? Extract(object obj)
        {
            foreach (var (leafType, leaf) in perLeaf)
                if (leafType.IsInstanceOfType(obj)) return leaf.Get(obj);
            return null;
        }

        // RouteWriter answers PropertyNotFound for a leaf that lacks this member, which ApplySubFields
        // treats as a silent no-op.
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

        // These members disagree on CLR type across leaves, so no one converter fits; the widened
        // applier resolves the target property's declared type at write time and converts into that.
        return new(colName, "string", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Extract, Apply: LeafWrite.Writable(WidenedLeaf.MakeWidenedApplier(pName, logger)), AllowsNull: true);
    }

    // Maps the value_type discriminator back through the same table the read side uses, then to that
    // interface's setter class closed over elemConcreteType's T. Null for any reason is the caller's
    // signal to refuse rather than guess.
    internal static Type? ResolveObjectModPropertyConcreteType(Type elemConcreteType, JsonElement elem)
    {
        if (!elem.TryGetProperty(ObjectModValueTypeDiscriminator, out var vt) || vt.ValueKind != JsonValueKind.String)
            return null;

        var match = Array.Find(LeafInterfaces, l => l.ValueTypeName == vt.GetString());
        if (match.InterfaceName == null) return null;

        var typeArgs = elemConcreteType.GetGenericArguments();
        var getterOpen = elemConcreteType.Assembly.GetType($"{elemConcreteType.Namespace}.{match.InterfaceName}");
        if (getterOpen == null) return null;

        // GetSetterType answers with the open generic setter class even off a closed getter interface,
        // so closing it over T is this method's job.
        var setterType = ReflectedTypes.GetSetterType(getterOpen.MakeGenericType(typeArgs));
        if (setterType is not { IsAbstract: false }) return null;
        return setterType.IsGenericTypeDefinition ? setterType.MakeGenericType(typeArgs) : setterType;
    }
}
