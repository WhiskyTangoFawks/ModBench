using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class ContainerSlotElementTypesTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    private static readonly ContainerDocuments Documents = new(Release);

    private sealed record Slot(Type Parent, string Name, Type Declared, string? TypeOfAnUnspelledChild);

    [Fact]
    public void EverySlot_TypesAChildThatSpellsNoTypeAsTheTypeItsOwnMemberDeclares()
    {
        var slots = ChildSlots().ToList();

        Assert.NotEmpty(slots);
        Assert.All(slots, slot => Assert.Equal(DeclaredTable(slot.Declared), slot.TypeOfAnUnspelledChild));
    }

    private static IEnumerable<Slot> ChildSlots() =>
        RecordClasses().SelectMany(parent => parent.GetProperties()
            .Select(property => (Property: property, Child: UnspelledChildIn(parent, property.Name)))
            .Where(found => found.Child is not null)
            .Select(found => new Slot(
                parent, found.Property.Name, ElementTypeOf(found.Property.PropertyType), found.Child?.RecordType)));

    private static ContainerDocuments.ChildDocument? UnspelledChildIn(Type parent, string slot)
    {
        using var document = JsonDocument.Parse($$$"""{"FormKey":"000800:Sweep.esp","{{{slot}}}":{"FormKey":"000801:Sweep.esp"}}""");
        return Documents.ChildrenOf(parent.Name, document.RootElement).Cast<ContainerDocuments.ChildDocument?>().SingleOrDefault();
    }

    private static string? DeclaredTable(Type declared) =>
        typeof(IMajorRecordGetter).IsAssignableFrom(declared) && !declared.IsAbstract
            ? RecordTypes.For(Release).RecordTypeNamed(declared.Name)
            : null;

    private static IEnumerable<Type> RecordClasses() =>
        ReferencedGameModules.Sweep()
            .SelectMany(module => module.GetTypes())
            .Where(type => type.IsClass && !type.IsAbstract && type.IsPublic
                           && typeof(IMajorRecord).IsAssignableFrom(type));

    private static Type ElementTypeOf(Type slotType) =>
        slotType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault()
        ?? slotType;
}
