using System.Reflection;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>A container's members come from the game assembly, so the next <c>Quest.Scenes</c> cannot
/// be missed. Swept from the schema's record types, which the derivation never consults, so it
/// cannot agree with itself.</summary>
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

        var derived = RecordTypes()
            .SelectMany(t => (ContainerChildFields.EnumerateChildFieldsFor(t) ?? []).Select(f => (t.Name, f)))
            .Order()
            .ToList();

        Assert.NotEmpty(expected);
        Assert.Equal(expected, derived);
    }

    [Fact]
    public void TheChildFields_AreASupersetOfTheEmbeddedSlots_AndTheDifferenceHasADirectoryOfItsOwn()
    {
        var embedded = ContainerChildFields.EmbeddedSlots.ToHashSet();
        var childFields = RecordTypes()
            .SelectMany(t => (ContainerChildFields.EnumerateChildFieldsFor(t) ?? []).Select(f => (t.Name, f)))
            .ToHashSet();

        Assert.Empty(embedded.Except(childFields));
        // The nested-group members are containment the document does not carry: their records live in
        // directories of their own, which is why they are child fields and not embedded slots.
        foreach (var (parent, slot) in childFields.Except(embedded))
        {
            var property = RecordTypes().Single(t => t.Name == parent).GetProperty(slot)!;
            Assert.False(TypedAsChildMajor(property), $"{parent}.{slot} is typed as a child major record, so it must be an embedded slot.");
        }
    }

    private static IOrderedEnumerable<(string Parent, string Member)> Sweep(Func<PropertyInfo, bool> holdsChildren) =>
        RecordTypes()
            .SelectMany(t => t.GetProperties().Where(holdsChildren).Select(p => (t.Name, p.Name)))
            .Order();

    // The schema's own record types, resolved to the concrete class through Mutagen's "I<Name>Getter"
    // naming convention.
    private static IEnumerable<Type> RecordTypes() =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .Select(s => ConcreteFor(s.RecordType))
            .OfType<Type>()
            .Distinct();

    private static Type? ConcreteFor(Type getterType) =>
        getterType.Name is ['I', .. var stem] && stem.EndsWith("Getter", StringComparison.Ordinal)
            ? getterType.Assembly.GetType($"{getterType.Namespace}.{stem[..^"Getter".Length]}")
            : null;

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
