using System.Reflection;
using MEditService.Codec.Serialization;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Schema;

/// <summary>A container's members come from the game assembly, so the next <c>Quest.Scenes</c> cannot
/// be missed. Swept through each record's getter interface, a route the derivation never takes, so
/// it cannot agree with itself.</summary>
public sealed class DerivedContainerMembersTests
{
    [Fact]
    public void TheEmbeddedSlots_AreExactlyTheMembersTypedAsAMajorRecordOrAListOfThem()
    {
        var expected = Sweep(TypedAsChildMajor).ToList();

        // A sweep that found nothing would agree with an empty derivation.
        Assert.NotEmpty(expected);
        Assert.Equal(expected, ContainerChildFields.EmbeddedSlots.Order().ToList());
    }

    [Fact]
    public void TheChildFields_AlsoNameTheMembersReachingChildRecordsThroughTheGamesNestedGroups()
    {
        var expected = Sweep(p => TypedAsChildMajor(p) || ReachesChildMajor(p.PropertyType, [])).ToList();

        Assert.NotEmpty(expected);
        Assert.Equal(expected, DerivedChildFields().Order().ToList());
    }

    [Fact]
    public void EveryRecordTypeInTheGameAssembly_IsSwept_IncludingTheOnesTheSchemaExcludes()
    {
        var swept = RecordTypes().Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var tabled = SchemaRecordTypeNames();

        // The schema drops land, navm, navi and the placed variants collapsed into refr, so a sweep
        // no broader than it would assert nothing about them.
        Assert.True(swept.Count > tabled.Count, "the sweep is no broader than the schema's record types.");
        Assert.Empty(tabled.Except(swept, StringComparer.Ordinal));

        // A derived member on a type outside the sweep is a member the tests above never reach.
        Assert.Empty(DerivedChildFields().Select(row => row.Parent).Distinct().Except(swept, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryEmbeddedSlotsElement_IsAMajorRecordByMutagensOwnReckoning()
    {
        var mod = ModFactory.Activator(ModKey.FromFileName("Sweep.esp"), GameRelease.Fallout4);

        foreach (var (parent, slot) in ContainerChildFields.EmbeddedSlots)
            Assert.True(EnumeratesAsMajorRecords(mod, ElementOf(parent, slot)), $"{parent}.{slot} holds no major record.");

        // The same oracle, negatively: what a child field names beyond an embedded slot is a nested
        // group, which Mutagen refuses to enumerate as a record.
        var nested = DerivedChildFields().Where(row => !ContainerChildFields.EmbeddedSlots.Contains(row)).ToList();
        Assert.NotEmpty(nested);
        foreach (var (parent, slot) in nested)
        {
            Assert.False(EnumeratesAsMajorRecords(mod, ElementOf(parent, slot)),
                $"{parent}.{slot} holds major records directly, so it belongs in the embedded slots.");
        }
    }

    // Mutagen's own registration: it enumerates a type it knows as a major record and throws for
    // anything else, a verdict the derivation's type tests do not produce.
    private static bool EnumeratesAsMajorRecords(IMod mod, Type element)
    {
        try
        {
            return mod.EnumerateMajorRecords(element).Count() >= 0;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static Type ElementOf(string parent, string slot)
    {
        var property = RecordTypes().First(t => t.Name == parent).GetProperty(slot)
            ?? throw new InvalidOperationException($"Expected '{parent}' to declare property '{slot}'.");
        return property.PropertyType.IsGenericType
            ? property.PropertyType.GetGenericArguments()[0]
            : property.PropertyType;
    }

    private static IEnumerable<(string Parent, string Member)> DerivedChildFields() =>
        RecordTypes().SelectMany(t => (ContainerChildFields.EnumerateChildFieldsFor(t) ?? []).Select(f => (t.Name, f)));

    private static IOrderedEnumerable<(string Parent, string Member)> Sweep(Func<PropertyInfo, bool> holdsChildren) =>
        RecordTypes()
            .SelectMany(t => t.GetProperties().Where(holdsChildren).Select(p => (t.Name, p.Name)))
            .Order();

    // Every record in every game module this build references, reached through its own getter
    // interface and Mutagen's "I<Name>Getter" naming convention.
    private static IEnumerable<Type> RecordTypes() =>
        Enum.GetValues<GameCategory>()
            .Select(GameModuleAssembly.For)
            .OfType<Assembly>()
            .SelectMany(module => module.GetTypes()
                .Where(type => type.IsInterface && typeof(IMajorRecordGetter).IsAssignableFrom(type))
                .Select(getter => ConcreteFor(module, getter))
                .OfType<Type>()
                .Where(type => type.IsClass && !type.IsAbstract && type.IsPublic));

    private static Type? ConcreteFor(Assembly module, Type getterType) =>
        getterType.Name is ['I', .. var stem] && stem.EndsWith("Getter", StringComparison.Ordinal)
            ? module.GetType($"{getterType.Namespace}.{stem[..^"Getter".Length]}")
            : null;

    // The mod header has a table of its own and is no record, so it is not swept and not expected.
    private static HashSet<string> SchemaRecordTypeNames() =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .Where(s => typeof(IMajorRecordGetter).IsAssignableFrom(s.RecordType))
            .Select(s => s.RecordType.Name[1..^"Getter".Length])
            .ToHashSet(StringComparer.Ordinal);

    private static bool TypedAsChildMajor(PropertyInfo property) =>
        typeof(IMajorRecordGetter).IsAssignableFrom(property.PropertyType)
        || (property.PropertyType.IsGenericType
            && !IsFormLink(property.PropertyType)
            && property.PropertyType.GetGenericArguments().Any(typeof(IMajorRecordGetter).IsAssignableFrom));

    // A worldspace's blocks: a list of a plain class whose own members reach the cells.
    private static bool ReachesChildMajor(Type type, HashSet<Type> seen)
    {
        if (!seen.Add(type) || IsFormLink(type)) return false;
        if (typeof(IMajorRecordGetter).IsAssignableFrom(type)) return true;
        if (type.IsGenericType) return type.GetGenericArguments().Any(a => ReachesChildMajor(a, seen));
        return type.Assembly == typeof(Mutagen.Bethesda.Fallout4.Fallout4Mod).Assembly
            && type.GetProperties().Any(p => ReachesChildMajor(p.PropertyType, seen));
    }

    // A reference, never embedded content: without this every FormLink member reads as containment.
    private static bool IsFormLink(Type type) =>
        type.IsGenericType && type.GetGenericTypeDefinition().Name.Contains("FormLink", StringComparison.Ordinal);
}
