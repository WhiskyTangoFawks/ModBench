using System.Collections.Concurrent;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Core.Serialization;

/// <summary>The slot facts a document read keys off: which members hold child records, which of
/// those the owner's own document carries inline, and what a slot's elements are.</summary>
internal sealed class ContainerSlots
{
    private static readonly ConcurrentDictionary<GameCategory, ContainerSlots> Readers = new();

    internal static ContainerSlots For(GameRelease release) =>
        Readers.GetOrAdd(release.ToCategory(), _ => new ContainerSlots());

    private readonly ContainerMembers _members;
    private readonly HashSet<string> _embeddedSlotNames;
    private readonly Dictionary<string, string> _elementTypeBySlotName;

    private ContainerSlots()
    {
        _members = ContainerMembers.Derived;
        _embeddedSlotNames = _members.EmbeddedSlots.Select(slot => slot.Slot).ToHashSet(StringComparer.Ordinal);
        _elementTypeBySlotName = _members.EmbeddedSlots
            .GroupBy(slot => slot.Slot, slot => _members.ElementTypeBySlot[slot], StringComparer.Ordinal)
            .Where(group => group.Distinct(StringComparer.Ordinal).Count() == 1)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
    }

    /// <summary>Every member of <paramref name="containerTypeName"/> holding child records, empty for
    /// a type with none.</summary>
    internal IReadOnlyList<string> ChildSlotsOf(string containerTypeName) =>
        _members.ChildFieldsByType.TryGetValue(containerTypeName, out var slots) ? slots : [];

    /// <summary>The members of <paramref name="containerTypeName"/> serializing their children
    /// inline. A null type answers with every container's, since nothing narrows it.</summary>
    internal IEnumerable<string> EmbeddedSlotsOf(string? containerTypeName) =>
        containerTypeName is null
            ? _embeddedSlotNames
            : _members.EmbeddedSlots.Where(slot => slot.ParentType == containerTypeName).Select(slot => slot.Slot);

    /// <summary>Whether a member serializes its children inline. A container whose text names no type
    /// of its own accepts any container's embedded slot name, since nothing narrows it.</summary>
    internal bool IsEmbeddedSlot(string? containerTypeName, string member) =>
        containerTypeName is null
            ? _embeddedSlotNames.Contains(member)
            : _members.EmbeddedSlots.Contains((containerTypeName, member));

    /// <summary>What a slot holds, for a document that does not spell its child's type. Falls back to
    /// the slot name alone when the owner's own type is not known.</summary>
    internal string? ElementTypeOf(string? containerTypeName, string slot) =>
        containerTypeName is { } owner && _members.ElementTypeBySlot.TryGetValue((owner, slot), out var element)
            ? element
            : _elementTypeBySlotName.GetValueOrDefault(slot);
}
