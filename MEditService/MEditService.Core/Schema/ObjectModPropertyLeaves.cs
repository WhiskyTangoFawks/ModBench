using System.Reflection;
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
            result.Add(BuildLeafUnionField([.. group], leaves.Count, game, logger));

        result.Add(BuildObjectModDiscriminatorField(baseGetterInterface, leaves));
        return result;
    }

    // The discriminator decides which concrete type the codec builds; setting it switches the leaf.
    private static SubFieldSpec BuildObjectModDiscriminatorField(
        Type baseGetterInterface, List<(Type LeafType, string LeafName)> leaves) =>
        new(LoquiUnions.UnionTypeDiscriminator, "enum", LeafSpec.NoFormKeyTypes,
            [.. leaves.Select(l => new EnumMember(
                l.LeafName,
                Label: LeafLabel.For(ReflectedTypes.LeafTypeName(baseGetterInterface), LeafLabel.ClassWord(l.LeafName))))],
            AllowsNull: true, DisplayLabel: LoquiUnions.UnionTypeDiscriminatorLabel, IsDiscriminator: true);

    // One member across the leaves declaring it, shaped as the first's. The variant map records each
    // declaring leaf's shape whenever the leaves disagree or one lacks the member, so a leaf switch
    // knows what the incoming leaf keeps.
    private static SubFieldSpec BuildLeafUnionField(
        List<(Type LeafType, string LeafName, PropertyInfo Prop)> members, int leafCount,
        GameReflection game, ILogger logger)
    {
        var distinctTypes = members
            .Select(m => Nullable.GetUnderlyingType(m.Prop.PropertyType) ?? m.Prop.PropertyType)
            .Distinct()
            .Count();
        if (distinctTypes == 1 && members.Count == leafCount)
        {
            var core = Nullable.GetUnderlyingType(members[0].Prop.PropertyType) ?? members[0].Prop.PropertyType;
            var rep = LeafClassification.ClassifyLeaf(members[0].Prop, core, game)!;
            return new(members[0].Prop.Name, rep.ApiType, rep.ValidFormKeyTypes, rep.EnumMembers, AllowsNull: true);
        }

        var variants = new Dictionary<string, SubFieldSpec>(StringComparer.Ordinal);
        foreach (var (_, valueTypeName, prop) in members)
        {
            if (SubFieldReflection.GetSubFieldInfo(prop, game, SubFieldReflection.RootPath, 1, logger) is { } spec)
                variants[valueTypeName] = spec;
        }
        return variants.Values.First() with { AllowsNull = true, Variants = variants };
    }
}
