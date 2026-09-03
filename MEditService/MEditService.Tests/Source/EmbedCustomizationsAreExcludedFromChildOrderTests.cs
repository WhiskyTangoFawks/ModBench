using System.Collections;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>
/// <see cref="SourceChildOrder"/> must skip every list the whole-mod writer embeds inline in its
/// owner's own document, and its exclusion set names them by hand — so this is what keeps that set
/// honest against <c>CellEmbedCustomization</c>/<c>WorldspaceEmbedCustomization</c>, which are the
/// actual authority.
///
/// <para><b>The failure this prevents is not subtle, but it is remote from its cause.</b> Treating an
/// embedded list as folder-split mints a directory per child that the writer never writes a record
/// into; the next read then fails on a missing <c>RecordData.json</c>, several layers away from the
/// customization that decided the list was embedded. Reproduced exactly that way during #566.</para>
/// </summary>
public sealed class EmbedCustomizationsAreExcludedFromChildOrderTests
{
    /// <summary>The list-shaped members the two embed customizations name. Kept as literals rather
    /// than reflected out of the customizations, because the customizations express themselves as
    /// lambdas over a builder — reflecting them would mean re-implementing the builder. Hand-written
    /// here, and the customization file is short enough to diff against by eye when it changes.
    /// <c>Cell.Landscape</c> and <c>Worldspace.TopCell</c> are embedded too but are single records,
    /// not lists, so <see cref="SourceChildOrder"/> never considers them.</summary>
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
        // The member really is the list-of-major-records shape the walk would otherwise pick up —
        // without this, an excluded name that no longer matched anything would still "pass".
        var property = owner.GetProperty(member);
        Assert.NotNull(property);
        var element = property.PropertyType.GetGenericArguments().FirstOrDefault();
        Assert.NotNull(element);
        Assert.True(
            typeof(IList).IsAssignableFrom(property.PropertyType),
            $"{owner.Name}.{member} is not list-shaped, so this row no longer guards anything.");
        Assert.True(
            typeof(IMajorRecordGetter).IsAssignableFrom(element),
            $"{owner.Name}.{member} is not a list of major records, so this row no longer guards anything.");

        Assert.Contains(member, SourceChildOrder.EmbeddedListMembers, StringComparer.Ordinal);
    }

    /// <summary>The exclusion set carries nothing beyond what the customizations embed — an excluded
    /// name that is not really embedded would silently drop a genuinely folder-split list's order,
    /// which is a lost-ordering bug rather than a loud one.</summary>
    [Fact]
    public void TheExclusionSet_NamesNothingBeyondTheEmbeddedLists()
    {
        var expected = EmbeddedLists.Select(row => (string)row[1]!).ToHashSet(StringComparer.Ordinal);

        Assert.Equal(expected.OrderBy(n => n, StringComparer.Ordinal), SourceChildOrder.EmbeddedListMembers.OrderBy(n => n, StringComparer.Ordinal));
    }
}
