using MEditService.Codec.Schema;
using MEditService.Codec.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class ContainerSlotElementTypesTests
{
    [Fact]
    public void EverySlot_NamesTheTypeItsOwnMemberDeclares()
    {
        var members = ContainerMembers.Derived;

        Assert.NotEmpty(members.ElementTypeBySlot);

        foreach (var ((_, parentType, slot), element) in members.ElementTypeBySlot)
        {
            var property = RecordTypes().First(type => type.Name == parentType).GetProperty(slot)
                ?? throw new InvalidOperationException($"Expected '{parentType}' to declare property '{slot}'.");
            var declared = ElementTypeOf(property.PropertyType)
                ?? throw new InvalidOperationException($"Expected '{parentType}.{slot}' to have a derivable element type.");
            Assert.Equal(declared.Name, element);
        }
    }

    [Fact]
    public void EverySlotHoldingChildFields_HasAnElementType()
    {
        var members = ContainerMembers.Derived;
        var missing = members.ChildFieldsByType
            .SelectMany(entry => entry.Value.Select(slot => (entry.Key.Game, entry.Key.Type, Slot: slot)))
            .Where(key => !members.ElementTypeBySlot.ContainsKey(key))
            .ToList();

        Assert.Empty(missing);
    }

    [Fact]
    public void NoTwoContainersSpellAnEmbeddedSlotTheSameAndMeanDifferentTypes_BecauseTheSlotNameAloneNamesAChildFoundBelowAKnownLevel()
    {
        var members = ContainerMembers.Derived;
        var ambiguous = members.EmbeddedSlots
            .GroupBy(slot => slot.Slot, slot => members.ElementTypeBySlot[slot], StringComparer.Ordinal)
            .Where(group => group.Distinct(StringComparer.Ordinal).Count() > 1)
            .Select(group => $"{group.Key} => {string.Join("/", group.Distinct(StringComparer.Ordinal))}")
            .ToList();

        Assert.NotEmpty(members.EmbeddedSlots);
        Assert.Empty(ambiguous);
    }

    private static IEnumerable<Type> RecordTypes() =>
        ReferencedGameModules.Sweep()
            .SelectMany(module => module.GetTypes())
            .Where(type => type.IsClass && !type.IsAbstract && type.IsPublic
                           && typeof(IMajorRecord).IsAssignableFrom(type));

    private static Type? ElementTypeOf(Type slotType) =>
        slotType.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault()
        ?? slotType;
}
