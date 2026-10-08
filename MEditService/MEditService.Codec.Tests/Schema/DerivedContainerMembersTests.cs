using System.Reflection;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class DerivedContainerMembersTests
{
    [Fact]
    public void TheEmbeddedSlots_AreExactlyTheMembersTypedAsAMajorRecordOrAListOfThem_SweptThroughTheGetterInterfaceARouteTheDerivationNeverTakes()
    {
        var expected = Sweep((_, p) => TypedAsChildMajor(p)).ToList();

        Assert.True(expected.Count > 0, "Expected the sweep to find slots; a sweep that found nothing would agree with an empty derivation.");
        Assert.Equal(expected, DerivedEmbeddedSlots().ToList());
    }

    [Fact]
    public void TheChildFields_AlsoNameTheMembersReachingChildRecordsThroughTheGamesNestedGroups()
    {
        var expected = Sweep((_, p) => TypedAsChildMajor(p) || ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(p.PropertyType, [])).ToList();

        Assert.NotEmpty(expected);
        Assert.Equal(expected, DerivedChildFields().Order().ToList());
    }

    [Fact]
    public void EveryRecordTypeInTheGameAssembly_IsSwept_IncludingTheSiblingsOfATablesBoundType_BecauseADerivedMemberOnATypeOutsideTheSweepIsOneTheOtherTestsNeverReach()
    {
        var swept = RecordClasses().Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var tabled = SchemaTablesWithoutTheModHeaderWhichHasATableOfItsOwnAndIsNoRecord();

        Assert.True(swept.Count > tabled.Count,
            "the sweep is no broader than the schema's tables, so it asserts nothing about the siblings sharing one, such as GMST's.");
        Assert.Empty(tabled.Except(swept.Select(Fallout4.RecordTypeNamed).OfType<string>(), StringComparer.Ordinal));

        Assert.Empty(DerivedChildFields().Select(row => row.Parent).Distinct().Except(swept, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryEmbeddedSlotsElement_IsAMajorRecordByMutagensOwnReckoning()
    {
        var mod = ModFactory.Activator(ModKey.FromFileName("Sweep.esp"), GameRelease.Fallout4);

        foreach (var (parent, slot) in DerivedEmbeddedSlots())
            Assert.True(EnumeratesAsMajorRecordsByMutagensOwnRegistration(mod, ElementOf(parent, slot)), $"{parent}.{slot} holds no major record.");

        var nestedGroupsWhichMutagenRefusesToEnumerateAsRecords = DerivedChildFields().Except(DerivedEmbeddedSlots()).ToList();
        Assert.NotEmpty(nestedGroupsWhichMutagenRefusesToEnumerateAsRecords);
        foreach (var (parent, slot) in nestedGroupsWhichMutagenRefusesToEnumerateAsRecords)
        {
            Assert.False(EnumeratesAsMajorRecordsByMutagensOwnRegistration(mod, ElementOf(parent, slot)),
                $"{parent}.{slot} holds major records directly, so it belongs in the embedded slots.");
        }
    }

    [Fact]
    public void AQuest_EmbedsItsScenes_ByItsClassNameAndByItsTable()
    {
        Assert.True(Fallout4.IsEmbeddedSlot("Quest", "Scenes"));
        Assert.True(Fallout4.IsEmbeddedSlot("qust", "Scenes"));
    }

    private static bool EnumeratesAsMajorRecordsByMutagensOwnRegistration(IMod mod, Type element)
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
        var property = RecordClasses().First(t => t.Name == parent).GetProperty(slot)
            ?? throw new InvalidOperationException($"Expected '{parent}' to declare property '{slot}'.");
        return property.PropertyType.IsGenericType
            ? property.PropertyType.GetGenericArguments()[0]
            : property.PropertyType;
    }

    private static readonly RecordTypes Fallout4 = RecordTypes.For(GameRelease.Fallout4);

    private static IEnumerable<(string Parent, string Member)> DerivedChildFields() =>
        RecordClasses().SelectMany(t => Fallout4.ChildSlotsOf(t.Name).Select(f => (t.Name, f)));

    private static IOrderedEnumerable<(string Parent, string Member)> DerivedEmbeddedSlots() =>
        Sweep((t, p) => Fallout4.IsEmbeddedSlot(t.Name, p.Name));

    private static IOrderedEnumerable<(string Parent, string Member)> Sweep(Func<Type, PropertyInfo, bool> holdsChildren) =>
        RecordClasses()
            .SelectMany(t => t.GetProperties().Where(p => holdsChildren(t, p)).Select(p => (t.Name, p.Name)))
            .Order();

    private static IEnumerable<Type> RecordClasses() =>
        ReferencedGameModules.Sweep()
            .SelectMany(module => module.GetTypes()
                .Where(type => type.IsInterface && typeof(IMajorRecordGetter).IsAssignableFrom(type))
                .Select(getter => ConcreteForByMutagensIStemGetterNamingConvention(module, getter))
                .OfType<Type>()
                .Where(type => type.IsClass && !type.IsAbstract && type.IsPublic));

    private static Type? ConcreteForByMutagensIStemGetterNamingConvention(Assembly module, Type getterType) =>
        getterType.Name is ['I', .. var stem] && stem.EndsWith("Getter", StringComparison.Ordinal)
            ? module.GetType($"{getterType.Namespace}.{stem[..^"Getter".Length]}")
            : null;

    private static HashSet<string> SchemaTablesWithoutTheModHeaderWhichHasATableOfItsOwnAndIsNoRecord() =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .Where(s => !s.IsHeader)
            .Select(s => s.TableName)
            .ToHashSet(StringComparer.Ordinal);

    private static bool TypedAsChildMajor(PropertyInfo property) =>
        typeof(IMajorRecordGetter).IsAssignableFrom(property.PropertyType)
        || (property.PropertyType.IsGenericType
            && !IsFormLinkAReferenceNotContainment(property.PropertyType)
            && property.PropertyType.GetGenericArguments().Any(typeof(IMajorRecordGetter).IsAssignableFrom));

    private static bool ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(Type type, HashSet<Type> seen)
    {
        if (!seen.Add(type) || IsFormLinkAReferenceNotContainment(type)) return false;
        if (typeof(IMajorRecordGetter).IsAssignableFrom(type)) return true;
        if (type.IsGenericType) return type.GetGenericArguments().Any(a => ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(a, seen));
        return type.Assembly == typeof(Mutagen.Bethesda.Fallout4.Fallout4Mod).Assembly
            && type.GetProperties().Any(p => ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(p.PropertyType, seen));
    }

    private static bool IsFormLinkAReferenceNotContainment(Type type) =>
        type.IsGenericType && type.GetGenericTypeDefinition().Name.Contains("FormLink", StringComparison.Ordinal);
}
