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

    private ContainerSlots(GameCategory category)
    {
        _category = category;
        _members = ContainerMembers.Derived;
        EmbeddedSlotNames = _members.EmbeddedSlots
            .Where(slot => slot.Game == category)
            .Select(slot => slot.Slot)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>Every member of <paramref name="containerTypeName"/> holding child records, empty for
    /// a type with none.</summary>
    internal IReadOnlyList<string> ChildSlotsOf(string containerTypeName) =>
        _members.ChildFieldsByType.TryGetValue((_category, containerTypeName), out var slots) ? slots : [];

    /// <summary>The names of the members serializing their children inline, across every container
    /// of the game.</summary>
    public IReadOnlySet<string> EmbeddedSlotNames { get; }

    /// <summary>Whether a member serializes its children inline. A container whose text names no type
    /// of its own accepts any container's embedded slot name, since nothing narrows it.</summary>
    internal bool IsEmbeddedSlot(string? containerTypeName, string member) =>
        containerTypeName is null
            ? EmbeddedSlotNames.Contains(member)
            : _members.EmbeddedSlots.Contains((_category, containerTypeName, member));

    /// <summary>Whether <paramref name="recordType"/> is a type the slot's own member declares it holds.</summary>
    internal bool Holds(string containerTypeName, string slot, Type recordType) =>
        _members.HeldTypesBySlot.TryGetValue((_category, containerTypeName, slot), out var held)
        && held.Any(type => type.IsAssignableFrom(recordType));

    /// <summary>What a slot holds, for a document that does not spell its child's type.</summary>
    internal string? ElementTypeOf(string containerTypeName, string slot) =>
        _members.ElementTypeBySlot.GetValueOrDefault((_category, containerTypeName, slot));
}
