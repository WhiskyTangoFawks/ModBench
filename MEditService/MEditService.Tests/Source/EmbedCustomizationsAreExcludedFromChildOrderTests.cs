using System.Collections;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>Treating an embedded list as folder-split carries an order the list already has, and
/// a write that trusted the carrier would disagree with the document beside it.</summary>
public sealed class EmbedCustomizationsAreExcludedFromChildOrderTests
{
    // Literals rather than reflected: the customizations are lambdas over a builder, so reflecting
    // them means re-implementing it. Landscape and TopCell are single records, never lists.
    public static TheoryData<Type, string> EmbeddedLists => new()
    {
        { typeof(Cell), nameof(Cell.Temporary) },
        { typeof(Cell), nameof(Cell.Persistent) },
        { typeof(Cell), nameof(Cell.NavigationMeshes) },
        { typeof(Quest), nameof(Quest.DialogTopics) },
        { typeof(Quest), nameof(Quest.DialogBranches) },
        { typeof(Quest), nameof(Quest.Scenes) },
        { typeof(DialogTopic), nameof(DialogTopic.Responses) },
    };

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public void EveryEmbeddedList_IsAnEmbeddedSlot(Type owner, string member)
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

        Assert.Contains((owner.Name, member), ContainerChildFields.EmbeddedSlots);
    }

    [Fact]
    public void TheEmbeddedSlots_NameNoListBeyondTheEmbeddedLists()
    {
        var expected = EmbeddedLists.Select(row => (((Type)row[0]!).Name, (string)row[1]!)).Order().ToList();

        var listShaped = ContainerChildFields.EmbeddedSlots
            .Where(slot => typeof(IList).IsAssignableFrom(
                typeof(Cell).Assembly.GetType($"{typeof(Cell).Namespace}.{slot.ParentType}")!.GetProperty(slot.Slot)!.PropertyType))
            .Order()
            .ToList();

        Assert.Equal(expected, listShaped);
    }
}
