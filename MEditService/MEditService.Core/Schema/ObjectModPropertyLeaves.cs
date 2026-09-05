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
    private static readonly string[] LeafInterfaces =
    [
        "IObjectModIntPropertyGetter`1",
        "IObjectModFloatPropertyGetter`1",
        "IObjectModBoolPropertyGetter`1",
        "IObjectModStringPropertyGetter`1",
        "IObjectModEnumPropertyGetter`1",
        "IObjectModFormLinkIntPropertyGetter`1",
        "IObjectModFormLinkFloatPropertyGetter`1",
    ];

    // "IObjectModIntPropertyGetter`1" names the class ObjectModIntProperty`1.
    private static string ClassNameOfGetter(string interfaceName)
    {
        const string prefix = "I";
        const string suffix = "Getter`1";
        return interfaceName[prefix.Length..^suffix.Length] + "`1";
    }

    internal static bool IsObjectModPropertyBase(Type getterInterface) =>
        getterInterface.IsGenericType &&
        getterInterface.GetGenericTypeDefinition().Name == "IAObjectModPropertyGetter`1";

    // Resolved by name off getterInterface's namespace so any game's assembly works. A member the
    // leaves type alike is one sub-field; one they disagree on has a variant per leaf. The
    // discriminator is added last.
    internal static List<SubFieldSpec> BuildObjectModPropertyLeafFields(
        Type baseGetterInterface, GameReflection game, ILogger logger)
    {
        var ns = baseGetterInterface.Namespace;
        var asm = baseGetterInterface.Assembly;
        var args = baseGetterInterface.GetGenericArguments();

        var leaves = new List<(Type LeafType, string LeafName)>();
        foreach (var interfaceName in LeafInterfaces)
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
            // The codec names the leaf by its closed setter class, which Loqui spells from the
            // getter's own name (IXGetter`1 for X<T>); the closed class is checked below to agree.
            var valueTypeName = ReflectedTypes.DocumentTypeName(ClassNameOfGetter(interfaceName), args);
            leaves.Add((open.MakeGenericType(args), valueTypeName));
        }
        foreach (var (leafType, valueTypeName) in leaves)
        {
            var spelled = ReflectedTypes.DocumentTypeName(ReflectedTypes.GetSetterType(leafType)!, args);
            if (spelled != valueTypeName)
            {
                throw new InvalidOperationException(
                    $"OMOD leaf {leafType.Name} is spelled {spelled} by its setter class but {valueTypeName} by the leaf table.");
            }
        }

        var members = leaves
            .SelectMany(leaf => leaf.LeafType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => !game.Annotations.IsExcludedMember(p))
                .Select(p => (LeafType: leaf.LeafType, leaf.LeafName, Prop: p)))
            .GroupBy(m => m.Prop.Name, StringComparer.Ordinal);

        var result = new List<SubFieldSpec>();
        foreach (var group in members)
        {
            var list = group.ToList();
            var distinctTypes = list
                .Select(m => Nullable.GetUnderlyingType(m.Prop.PropertyType) ?? m.Prop.PropertyType)
                .Distinct()
                .ToList();

            result.Add(distinctTypes.Count == 1
                ? BuildTypedLeafUnionField(list, game, logger)
                : BuildVariantLeafUnionField(list, game, logger));
        }

        result.Add(BuildObjectModDiscriminatorField(baseGetterInterface, leaves));
        return result;
    }

    // Read-only deliberately: it decides which concrete type gets constructed, so it cannot be applied
    // to an already-constructed object; ResolveObjectModPropertyConcreteType reads it off the JSON
    // before any object exists.
    private static SubFieldSpec BuildObjectModDiscriminatorField(
        Type baseGetterInterface, List<(Type LeafType, string LeafName)> leaves) =>
        new(LoquiUnions.UnionTypeDiscriminator, "enum", LeafSpec.NoFormKeyTypes,
            [.. leaves.Select(l => new EnumMember(
                l.LeafName,
                Label: LeafLabel.For(ReflectedTypes.LeafTypeName(baseGetterInterface), LeafLabel.ClassWord(l.LeafName))))],
            Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.DiscriminatorReason), AllowsNull: true,
            DisplayLabel: LoquiUnions.UnionTypeDiscriminatorLabel, IsDiscriminator: true);

    private static SubFieldSpec BuildTypedLeafUnionField(
        List<(Type LeafType, string LeafName, PropertyInfo Prop)> members,
        GameReflection game, ILogger logger)
    {
        var core = Nullable.GetUnderlyingType(members[0].Prop.PropertyType) ?? members[0].Prop.PropertyType;
        var rep = LeafClassification.ClassifyLeaf(members[0].Prop, core, game)!;

        // RouteWriter answers PropertyNotFound for a leaf that lacks this member, which ApplySubFields
        // treats as a silent no-op. Every member here shares one CLR property name, so one applier
        // resolved off the constructed leaf covers every leaf.
        var apply = LeafWriters.RouteWriter<object>(rep, members[0].Prop, core, nullable: true, game, logger);

        return new(members[0].Prop.Name, rep.ApiType, rep.ValidFormKeyTypes, rep.EnumMembers,
            apply,
            AllowsNull: true);
    }

    // These members disagree on CLR type across leaves, so no one converter fits; each leaf's own
    // shape is its variant, and the widened applier resolves the target property's declared type at
    // write time and converts into that.
    private static SubFieldSpec BuildVariantLeafUnionField(
        List<(Type LeafType, string LeafName, PropertyInfo Prop)> members, GameReflection game, ILogger logger)
    {
        var pName = members[0].Prop.Name;
        var variants = new Dictionary<string, SubFieldSpec>(StringComparer.Ordinal);
        foreach (var (_, valueTypeName, prop) in members)
        {
            if (SubFieldReflection.GetSubFieldInfo(prop, game, SubFieldReflection.RootPath, 1, logger) is { } spec)
                variants[valueTypeName] = spec;
        }
        var rep = variants.Values.First();
        return rep with
        {
            Apply = LeafWrite.Writable(WidenedLeaf.MakeWidenedApplier(pName, logger)),
            AllowsNull = true,
            Variants = variants,
        };
    }

    // Maps the document's discriminator back through the same table the read side uses, then to that
    // interface's setter class closed over elemConcreteType's T. Null for any reason is the caller's
    // signal to refuse rather than guess.
    internal static Type? ResolveObjectModPropertyConcreteType(Type elemConcreteType, JsonElement elem)
    {
        if (!elem.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var vt) || vt.ValueKind != JsonValueKind.String)
            return null;

        var typeArgs = elemConcreteType.GetGenericArguments();
        foreach (var interfaceName in LeafInterfaces)
        {
            var getterOpen = elemConcreteType.Assembly.GetType($"{elemConcreteType.Namespace}.{interfaceName}");
            if (getterOpen == null) continue;

            // GetSetterType answers with the open generic setter class even off a closed getter interface,
            // so closing it over T is this method's job.
            var setterType = ReflectedTypes.GetSetterType(getterOpen.MakeGenericType(typeArgs));
            if (setterType is not { IsAbstract: false }) continue;
            if (ReflectedTypes.DocumentTypeName(setterType, typeArgs) != vt.GetString()) continue;
            return setterType.IsGenericTypeDefinition ? setterType.MakeGenericType(typeArgs) : setterType;
        }
        return null;
    }
}
