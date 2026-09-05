using System.Collections;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>Treating an embedded list as folder-split mints a directory per child the writer
/// never fills, and the next read fails several layers from the cause.</summary>
public sealed class EmbedCustomizationsAreExcludedFromChildOrderTests
{
    // Literals rather than reflected: the customizations are lambdas over a builder, so reflecting
    // them means re-implementing it. Landscape and TopCell are single records, never lists.
    public static TheoryData<Type, string> EmbeddedLists => new()
    {
        { typeof(Cell), nameof(Cell.Temporary) },
        { typeof(Cell), nameof(Cell.Persistent) },
        { typeof(Cell), nameof(Cell.NavigationMeshes) },
    };

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public void EveryEmbeddedList_IsExcludedFromTheOrderedChildWalk(Type owner, string member)
    {
        // The member really is the list-of-major-records shape the walk would otherwise pick up: without
        // this, an excluded name matching nothing would still "pass".
        var property = owner.GetProperty(member);
        Assert.NotNull(property);
        var element = property.PropertyType.GetGenericArguments().FirstOrDefault();
        Assert.NotNull(element);
        Assert.True(
            typeof(IList).IsAssignableFrom(property.PropertyType),
            $"{owner.Name}.{member} is not list-shaped, so this row does not guard anything.");
        Assert.True(
            typeof(IMajorRecordGetter).IsAssignableFrom(element),
            $"{owner.Name}.{member} is not a list of major records, so this row does not guard anything.");

        Assert.Contains(member, SourceChildOrder.EmbeddedListMembers, StringComparer.Ordinal);
    }

    [Fact]
    public void TheExclusionSet_NamesNothingBeyondTheEmbeddedLists()
    {
        var expected = EmbeddedLists.Select(row => (string)row[1]!).ToHashSet(StringComparer.Ordinal);

        Assert.Equal(expected.OrderBy(n => n, StringComparer.Ordinal), SourceChildOrder.EmbeddedListMembers.OrderBy(n => n, StringComparer.Ordinal));
    }
}
