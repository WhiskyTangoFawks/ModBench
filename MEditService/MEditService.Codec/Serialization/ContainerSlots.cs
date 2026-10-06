using System.Collections.Concurrent;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>The slot facts a document read keys off: which members hold child records, which of
/// those the owner's own document carries inline, and what a slot's elements are.</summary>
public sealed class ContainerSlots
{
    private static readonly ConcurrentDictionary<GameCategory, ContainerSlots> Readers = new();

    public static ContainerSlots For(GameRelease release) =>
        Readers.GetOrAdd(release.ToCategory(), category => new ContainerSlots(category));

    private readonly GameCategory _category;
    private readonly ContainerMembers _members;
    private readonly HashSet<string> _embeddedSlotNames;
    private readonly Dictionary<string, string> _elementTypeBySlotName;

    private ContainerSlots(GameCategory category)
    {
        _category = category;
        _members = ContainerMembers.Derived;
        var embeddedSlots = _members.EmbeddedSlots.Where(slot => slot.Game == category).ToList();
        _embeddedSlotNames = embeddedSlots.Select(slot => slot.Slot).ToHashSet(StringComparer.Ordinal);
        _elementTypeBySlotName = embeddedSlots
            .GroupBy(slot => slot.Slot, slot => _members.ElementTypeBySlot[slot], StringComparer.Ordinal)
            .Where(group => group.Distinct(StringComparer.Ordinal).Count() == 1)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
    }

    /// <summary>Every member of <paramref name="containerTypeName"/> holding child records, empty for
    /// a type with none.</summary>
    internal IReadOnlyList<string> ChildSlotsOf(string containerTypeName) =>
        _members.ChildFieldsByType.TryGetValue((_category, containerTypeName), out var slots) ? slots : [];

    /// <summary>The members of <paramref name="containerTypeName"/> serializing their children
    /// inline. A null type answers with every container's, since nothing narrows it.</summary>
    public IEnumerable<string> EmbeddedSlotsOf(string? containerTypeName) =>
        containerTypeName is null
            ? _embeddedSlotNames
            : _members.EmbeddedSlots.Where(slot => slot.Game == _category && slot.ParentType == containerTypeName).Select(slot => slot.Slot);

    /// <summary>Whether a member serializes its children inline. A container whose text names no type
    /// of its own accepts any container's embedded slot name, since nothing narrows it.</summary>
    internal bool IsEmbeddedSlot(string? containerTypeName, string member) =>
        containerTypeName is null
            ? _embeddedSlotNames.Contains(member)
            : _members.EmbeddedSlots.Contains((_category, containerTypeName, member));

    /// <summary>Whether <paramref name="recordType"/> is a type the slot's own member declares it holds.</summary>
    internal bool Holds(string containerTypeName, string slot, Type recordType) =>
        _members.HeldTypesBySlot.TryGetValue((_category, containerTypeName, slot), out var held)
        && held.Any(type => type.IsAssignableFrom(recordType));

    /// <summary>What a slot holds, for a document that does not spell its child's type. Falls back to
    /// the slot name alone when the owner's own type is not known.</summary>
    internal string? ElementTypeOf(string? containerTypeName, string slot) =>
        containerTypeName is { } owner && _members.ElementTypeBySlot.TryGetValue((_category, owner, slot), out var element)
            ? element
            : _elementTypeBySlotName.GetValueOrDefault(slot);
}
