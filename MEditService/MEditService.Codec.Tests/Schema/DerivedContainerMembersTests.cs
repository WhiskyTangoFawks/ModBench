using System.Reflection;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class DerivedContainerMembersTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void TheEmbeddedSlots_AreExactlyTheMembersTypedAsAMajorRecordOrAListOfThem_SweptThroughTheGetterInterfaceARouteTheDerivationNeverTakes(GameRelease release)
    {
        var expected = Sweep(release, (_, p) => TypedAsChildMajor(p)).ToList();

        Assert.True(expected.Count > 0, "Expected the sweep to find slots; a sweep that found nothing would agree with an empty derivation.");
        Assert.Equal(expected, DerivedEmbeddedSlots(release).ToList());
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void TheChildFields_AlsoNameTheMembersReachingChildRecordsThroughTheGamesNestedGroups(GameRelease release)
    {
        var module = GameModule(release);
        var expected = Sweep(release, (_, p) => TypedAsChildMajor(p) || ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(p.PropertyType, module, [])).ToList();

        Assert.NotEmpty(expected);
        Assert.Equal(expected, DerivedChildFields(release).Order().ToList());
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void EveryRecordTypeInTheGameAssembly_IsSwept_IncludingTheSiblingsOfATablesBoundType_BecauseADerivedMemberOnATypeOutsideTheSweepIsOneTheOtherTestsNeverReach(GameRelease release)
    {
        var swept = RecordClasses(release).Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var tabled = SchemaTablesWithoutTheModHeaderWhichHasATableOfItsOwnAndIsNoRecord(release);

        Assert.True(swept.Count > tabled.Count,
            "the sweep is no broader than the schema's tables, so it asserts nothing about the siblings sharing one, such as GMST's.");
        Assert.Empty(tabled.Except(swept.Select(RecordTypes.For(release).RecordTypeNamed).OfType<string>(), StringComparer.Ordinal));

        Assert.Empty(DerivedChildFields(release).Select(row => row.Parent).Distinct().Except(swept, StringComparer.Ordinal));
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void EveryEmbeddedSlotsElement_IsAMajorRecordByMutagensOwnReckoning(GameRelease release)
    {
        var mod = ModFactory.Activator(ModKey.FromFileName("Sweep.esp"), release);
        var nestedGroupsWhichMutagenRefusesToEnumerateAsRecords = DerivedChildFields(release).Except(DerivedEmbeddedSlots(release)).ToList();

        Assert.NotEmpty(nestedGroupsWhichMutagenRefusesToEnumerateAsRecords);
        Assert.Empty(DerivedEmbeddedSlots(release).Where(slot => !EnumeratesAsMajorRecordsByMutagensOwnRegistration(mod, ElementOf(release, slot.Parent, slot.Member))).Select(slot => slot.Parent + "." + slot.Member));
        Assert.Empty(nestedGroupsWhichMutagenRefusesToEnumerateAsRecords.Where(slot => EnumeratesAsMajorRecordsByMutagensOwnRegistration(mod, ElementOf(release, slot.Parent, slot.Member))).Select(slot => slot.Parent + "." + slot.Member));
    }

    [Fact]
    public void AQuest_EmbedsItsScenes_ByItsClassNameAndByItsTable()
    {
        var fallout4 = RecordTypes.For(GameRelease.Fallout4);

        Assert.True(fallout4.IsEmbeddedSlot("Quest", "Scenes"));
        Assert.True(fallout4.IsEmbeddedSlot("qust", "Scenes"));
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

    private static Type ElementOf(GameRelease release, string parent, string slot)
    {
        var property = RecordClasses(release).First(t => t.Name == parent).GetProperty(slot)
            ?? throw new InvalidOperationException($"Expected '{parent}' to declare property '{slot}'.");
        return property.PropertyType.IsGenericType
            ? property.PropertyType.GetGenericArguments()[0]
            : property.PropertyType;
    }

    private static IEnumerable<(string Parent, string Member)> DerivedChildFields(GameRelease release) =>
        RecordClasses(release).SelectMany(t => RecordTypes.For(release).ChildSlotsOf(t.Name).Select(f => (t.Name, f)));

    private static IOrderedEnumerable<(string Parent, string Member)> DerivedEmbeddedSlots(GameRelease release) =>
        Sweep(release, (t, p) => RecordTypes.For(release).IsEmbeddedSlot(t.Name, p.Name));

    private static IOrderedEnumerable<(string Parent, string Member)> Sweep(GameRelease release, Func<Type, PropertyInfo, bool> holdsChildren) =>
        RecordClasses(release)
            .SelectMany(t => t.GetProperties().Where(p => holdsChildren(t, p)).Select(p => (t.Name, p.Name)))
            .Order();

    private static Assembly GameModule(GameRelease release) => Assembly.Load($"Mutagen.Bethesda.{release.ToCategory()}");

    private static IEnumerable<Type> RecordClasses(GameRelease release)
    {
        var module = GameModule(release);
        return module.GetTypes()
            .Where(type => type.IsInterface && typeof(IMajorRecordGetter).IsAssignableFrom(type))
            .Select(getter => ConcreteForByMutagensIStemGetterNamingConvention(module, getter))
            .OfType<Type>()
            .Where(type => type.IsClass && !type.IsAbstract && type.IsPublic);
    }

    private static Type? ConcreteForByMutagensIStemGetterNamingConvention(Assembly module, Type getterType) =>
        getterType.Name is ['I', .. var stem] && stem.EndsWith("Getter", StringComparison.Ordinal)
            ? module.GetType($"{getterType.Namespace}.{stem[..^"Getter".Length]}")
            : null;

    private static HashSet<string> SchemaTablesWithoutTheModHeaderWhichHasATableOfItsOwnAndIsNoRecord(GameRelease release) =>
        SharedSchemaReflector.Instance.GetSchemas(release).Values
            .Where(s => !s.IsHeader)
            .Select(s => s.TableName)
            .ToHashSet(StringComparer.Ordinal);

    private static bool TypedAsChildMajor(PropertyInfo property) =>
        typeof(IMajorRecordGetter).IsAssignableFrom(property.PropertyType)
        || (property.PropertyType.IsGenericType
            && !IsFormLinkAReferenceNotContainment(property.PropertyType)
            && property.PropertyType.GetGenericArguments().Any(typeof(IMajorRecordGetter).IsAssignableFrom));

    private static bool ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(Type type, Assembly module, HashSet<Type> seen)
    {
        if (!seen.Add(type) || IsFormLinkAReferenceNotContainment(type)) return false;
        if (typeof(IMajorRecordGetter).IsAssignableFrom(type)) return true;
        if (type.IsGenericType) return type.GetGenericArguments().Any(a => ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(a, module, seen));
        return type.Assembly == module
            && type.GetProperties().Any(p => ReachesChildMajorThroughAPlainClassLikeAWorldspacesBlocks(p.PropertyType, module, seen));
    }

    private static bool IsFormLinkAReferenceNotContainment(Type type) =>
        type.IsGenericType && type.GetGenericTypeDefinition().Name.Contains("FormLink", StringComparison.Ordinal);
}
