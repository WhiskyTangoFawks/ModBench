using System.Collections.Concurrent;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Core.Serialization;

/// <summary>The one reader of a container's slot facts: which members hold child records, which of
/// those the owner's own document carries inline, and what a slot's elements are.</summary>
internal sealed class ContainerSlots
{
    private static readonly ConcurrentDictionary<GameCategory, ContainerSlots> Readers = new();

    internal static ContainerSlots For(GameRelease release) =>
        Readers.GetOrAdd(release.ToCategory(), _ => new ContainerSlots(release));

    private readonly RecordTypeDispatch _dispatch;
    private readonly ContainerMembers _members;
    private readonly HashSet<string> _embeddedSlotNames;
    private readonly Dictionary<string, string> _elementTypeBySlotName;

    private ContainerSlots(GameRelease release)
    {
        _dispatch = RecordTypeDispatch.For(release);
        _members = ContainerMembers.Derived;
        _embeddedSlotNames = _members.EmbeddedSlots.Select(slot => slot.Slot).ToHashSet(StringComparer.Ordinal);
        _elementTypeBySlotName = _members.ElementTypeBySlot
            .GroupBy(entry => entry.Key.Slot, entry => entry.Value, StringComparer.Ordinal)
            .Where(group => group.Distinct(StringComparer.Ordinal).Count() == 1)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
    }

    /// <summary>The concrete class name a container's slot table is keyed by, which is the codec's
    /// spelling of the type rather than the schema's table name.</summary>
    internal string? ContainerTypeOf(string? recordType) =>
        recordType is null ? null : _dispatch.ConcreteFor(recordType)?.Name ?? recordType;

    /// <summary>Every member of <paramref name="containerTypeName"/> holding child records, empty for
    /// a type with none.</summary>
    internal IReadOnlyList<string> ChildSlotsOf(string containerTypeName) =>
        _members.ChildFieldsByType.TryGetValue(containerTypeName, out var slots) ? slots : [];

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
