using System.Reflection;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class ContainerSlotElementTypesTests
{
    private sealed record Slot(Type Parent, string Name, Type Declared, string? TypeOfAnUnspelledChild);

    private static readonly string[] Containers = ["Cell", "DialogTopic", "Quest", "Worldspace"];

    private static readonly string[] SlotNamesOfEveryGame =
        ["DialogBranches", "DialogTopics", "Landscape", "NavigationMeshes", "Persistent", "Responses", "Scenes", "SubCells", "Temporary", "TopCell"];

    [Theory]
    [InlineData(
        GameRelease.Fallout4,
        "Cell.Landscape Cell.NavigationMeshes Cell.Persistent Cell.Temporary DialogTopic.Responses " +
        "Quest.DialogBranches Quest.DialogTopics Quest.Scenes Worldspace.SubCells Worldspace.TopCell")]
    [InlineData(
        GameRelease.SkyrimSE,
        "Cell.Landscape Cell.NavigationMeshes Cell.Persistent Cell.Temporary DialogTopic.Responses Worldspace.SubCells Worldspace.TopCell")]
    [InlineData(
        GameRelease.Starfield,
        "Cell.NavigationMeshes Cell.Persistent Cell.Temporary DialogTopic.Responses " +
        "Quest.DialogBranches Quest.DialogTopics Quest.Scenes Worldspace.SubCells Worldspace.TopCell")]
    public void AContainersChild_IsReadOutOfExactlyTheSlotsItsOwnGameGivesIt(GameRelease release, string slots)
    {
        var documents = new ContainerDocuments(release);

        var read = from container in Containers
                   from slot in SlotNamesOfEveryGame
                   where UnspelledChildIn(documents, container, slot) is not null
                   select $"{container}.{slot}";

        Assert.Equal(slots.Split(' '), read);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void EverySlot_TypesAChildThatSpellsNoTypeAsTheTypeItsOwnMemberDeclares(GameRelease release)
    {
        var slots = ChildSlots(release).ToList();

        Assert.NotEmpty(slots);
        Assert.All(slots, slot => Assert.Equal(DeclaredTable(release, slot.Declared), slot.TypeOfAnUnspelledChild));
    }

    private static IEnumerable<Slot> ChildSlots(GameRelease release)
    {
        var documents = new ContainerDocuments(release);
        return RecordClasses(release).SelectMany(parent => parent.GetProperties()
            .Select(property => (Property: property, Child: UnspelledChildIn(documents, parent.Name, property.Name)))
            .Where(found => found.Child is not null)
            .Select(found => new Slot(
                parent, found.Property.Name, ElementTypeOf(found.Property.PropertyType), found.Child?.RecordType)));
    }

    private static ContainerDocuments.ChildDocument? UnspelledChildIn(ContainerDocuments documents, string container, string slot)
    {
        var document = Document.Parse($$$"""{"FormKey":"000800:Sweep.esp","{{{slot}}}":{"FormKey":"000801:Sweep.esp"}}""");
        return documents.ChildrenOf(container, document).Cast<ContainerDocuments.ChildDocument?>().SingleOrDefault();
    }

    private static string? DeclaredTable(GameRelease release, Type declared) =>
        typeof(IMajorRecordGetter).IsAssignableFrom(declared) && !declared.IsAbstract
            ? RecordTypes.For(release).RecordTypeNamed(declared.Name)
            : null;

    private static IEnumerable<Type> RecordClasses(GameRelease release) =>
        Assembly.Load($"Mutagen.Bethesda.{release.ToCategory()}").GetTypes()
            .Where(type => type.IsClass && !type.IsAbstract && type.IsPublic
                           && typeof(IMajorRecord).IsAssignableFrom(type));

    private static Type ElementTypeOf(Type slotType) =>
        slotType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault()
        ?? slotType;
}
