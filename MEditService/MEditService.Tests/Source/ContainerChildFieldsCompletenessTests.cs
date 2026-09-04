using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>The standing defence against the next <c>Quest.Scenes</c>: a Mutagen bump adding a child-major
/// field nobody put in the hand-maintained table.</summary>
public sealed class ContainerChildFieldsCompletenessTests
{
    [Fact]
    public void EveryChildMajorRecordField_IsRepresentedInContainerChildFieldsTable()
    {
        var release = GameRelease.Fallout4;
        var schemas = SharedSchemaReflector.Instance.GetSchemas(release);
        var mod = ModFactory.Activator(ModKey.FromFileName("Sweep.esp"), release);

        // Every schema-registered getter type resolved to its concrete setter class (Mutagen's own
        // "I<Name>Getter" -> "<Name>" naming convention — the same one RecordTextCodec's dispatch and
        // ContainerChildFields' DeepCopy resolution both already rely on).
        var majorRecordTypes = schemas.Values
            .Select(s => ConcreteTypeFor(s.RecordType))
            .Where(t => t != null)
            .Cast<Type>()
            .Distinct()
            .ToList();
        Assert.NotEmpty(majorRecordTypes);

        // A "child-major" type: a major record type Mutagen never gives its own top-level group —
        // Cell, PlacedObject/PlacedNpc/..., DialogTopic, DialogResponses, DialogBranch,
        // NavigationMesh, Landscape, Scene, and whatever else this game module adds next.
        var childMajorTypes = majorRecordTypes.Where(t => !HasTopLevelGroup(mod, t)).ToHashSet();
        Assert.NotEmpty(childMajorTypes); // sanity: the rule must find *something*, or it's broken

        var gaps = new List<string>();
        foreach (var parentType in majorRecordTypes)
        {
            foreach (var property in parentType.GetProperties())
            {
                var elementType = ElementTypeIfChildMajor(property.PropertyType, childMajorTypes);
                if (elementType == null) continue;

                var covered = ContainerChildFields.EnumerateChildFieldsFor(parentType) is { } fields
                    && fields.Contains(property.Name);
                if (!covered)
                    gaps.Add($"{parentType.Name}.{property.Name} (-> {elementType.Name})");
            }
        }

        Assert.True(gaps.Count == 0,
            $"ContainerChildFields' table is missing: {string.Join(", ", gaps)}. " +
            "Add the field to ByTypeName (and container_child will pick up parentage automatically).");
    }

    private static Type? ConcreteTypeFor(Type getterType)
    {
        var name = getterType.Name;
        if (name.Length == 0 || name[0] != 'I' || !name.EndsWith("Getter", StringComparison.Ordinal))
            return null;
        var concreteName = name[1..^"Getter".Length];
        return getterType.Assembly.GetType($"{getterType.Namespace}.{concreteName}");
    }

    private static bool HasTopLevelGroup(IMod mod, Type majorRecordType)
    {
        try
        {
            return mod.TryGetTopLevelGroup(majorRecordType) != null;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    // The same shape-only rule ContainerChildFields' own doc comment describes: a property is
    // child-major if its type, or the element type of a collection it declares, is itself a
    // known child-major type.
    private static Type? ElementTypeIfChildMajor(Type propertyType, HashSet<Type> childMajorTypes)
    {
        if (childMajorTypes.Contains(propertyType)) return propertyType;

        // A FormLink is a 4-byte reference, never embedded content: containment is ExtendedList<Scene> or
        // a bare Scene. Excluded before walking generic arguments, or every reference field reads as a
        // false "contains" (19 of them, none real).
        if (propertyType.IsGenericType
            && propertyType.GetGenericTypeDefinition().Name.Contains("FormLink", StringComparison.Ordinal))
            return null;

        if (propertyType.IsGenericType)
        {
            foreach (var arg in propertyType.GetGenericArguments())
            {
                if (childMajorTypes.Contains(arg)) return arg;
                // Overlay/generated shapes often declare the *getter* element (e.g. IDialogTopicGetter)
                // rather than the concrete setter type this sweep's own childMajorTypes set is keyed
                // by — resolve through the same naming convention before giving up on this argument.
                if (ConcreteTypeFor(arg) is { } concrete && childMajorTypes.Contains(concrete))
                    return concrete;
            }
        }
        return null;
    }
}
