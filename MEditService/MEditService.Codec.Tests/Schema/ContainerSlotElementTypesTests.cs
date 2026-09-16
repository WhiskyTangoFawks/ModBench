using System.Reflection;
using MEditService.Codec.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Schema;

/// <summary>Each slot's element type, derived from the same game modules as the slots themselves, so
/// a document read names an embedded child's class without deserializing its owner.</summary>
public sealed class ContainerSlotElementTypesTests
{
    [Fact]
    public void EverySlot_NamesTheTypeItsOwnMemberDeclares()
    {
        var members = ContainerMembers.Derived;

        // A derivation that stored nothing would agree with every assertion below.
        Assert.NotEmpty(members.ElementTypeBySlot);

        foreach (var ((parentType, slot), element) in members.ElementTypeBySlot)
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
            .SelectMany(entry => entry.Value.Select(slot => (entry.Key, slot)))
            .Where(slot => !members.ElementTypeBySlot.ContainsKey(slot))
            .ToList();

        Assert.Empty(missing);
    }

    // What lets a read that found a child below the level whose type it knows still name it: the
    // slot name alone decides.
    [Fact]
    public void NoTwoContainersSpellAnEmbeddedSlotTheSameAndMeanDifferentTypes()
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
        Enum.GetValues<GameCategory>()
            .Select(GameModuleAssembly.For)
            .OfType<Assembly>()
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
