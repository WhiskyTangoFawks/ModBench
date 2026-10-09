using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Edits;

/// <summary>The container record whose <see cref="Slot"/> holds a child record, and where that container is
/// held in turn.</summary>
internal sealed record HeldIn(SourceDocument Container, string Slot, HeldIn? ContainerHeldIn)
{
    /// <summary>Where <paramref name="record"/> sits as <paramref name="repository"/> reads it; null for a record
    /// no container holds.</summary>
    internal static Answer<HeldIn?, SourceFailure> Of(SourceRepository repository, PluginAddress plugin, RecordIdentity record) =>
        repository.ContainerOf(plugin, record).Then(held => held is not { } slot
            ? SourceAnswer.Of<HeldIn?>(null)
            : repository.Get(plugin, slot.ParentFormKey).Then(found =>
            {
                var container = found
                    ?? throw new InvalidOperationException($"Expected the container {slot.ParentFormKey} that holds {record.FormKey} to be held.");
                return Of(repository, plugin, container.Identity).Then(above => SourceAnswer.Of<HeldIn?>(
                    new HeldIn(container, slot.SlotName, above)));
            }));

    /// <summary>Whether the record held is a cell held as its worldspace's persistent cell.</summary>
    internal bool IsThePersistentCell => Slot == PlacedCell.WorldspacePersistentCellMember;

    /// <summary>Whether the record held sits in one of its cell's groups.</summary>
    internal bool IsPlaced => Slot is PersistentFlag.PersistentGroup or PersistentFlag.TemporaryGroup;
}
