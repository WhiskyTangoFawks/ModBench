using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>Where a cell sits, which narrows what xEdit's Add offers on it.</summary>
public enum CellPlace { Interior, Exterior, PersistentWorldspaceCell }

/// <summary>What xEdit's Add lists on a container record, among the types an open member of it holds
/// in the game. A type with no schema is left out: no row would show the new record.</summary>
public static class ChildRecordTypes
{
    private enum Narrowing { None, NotPersistent, Exterior }

    // TwbMainRecord.GetAddList (wbImplementation.pas), keyed by the container's signature.
    private static readonly Dictionary<string, (string Type, Narrowing Narrowing)[]> XEditAddList =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["dial"] = [("info", Narrowing.None)],
            ["qust"] = [("dial", Narrowing.None), ("dlbr", Narrowing.None), ("scen", Narrowing.None)],
            ["wrld"] = [("cell", Narrowing.None), ("road", Narrowing.None)],
            ["cell"] =
            [
                .. new[] { "achr", "acre", "refr", "pgre", "pmis", "parw", "pbea", "pfla", "pcon", "pbar", "phzd" }
                    .Select(type => (type, Narrowing.None)),
                ("land", Narrowing.Exterior), ("pgrd", Narrowing.NotPersistent), ("navm", Narrowing.NotPersistent),
            ],
        };

    /// <summary><paramref name="containerText"/> is the container's own document, which says whether it
    /// is deleted and which single-record members are filled. <paramref name="place"/> is null for a
    /// container that is no cell.</summary>
    public static IReadOnlyList<string> Of(
        string containerType, string containerText, CellPlace? place,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        if (!XEditAddList.TryGetValue(containerType, out var adds)) return [];
        var dispatch = RecordTypeDispatch.For(release);
        if (dispatch.ConcreteFor(containerType) is not { } container) return [];
        using var document = JsonDocument.Parse(containerText);
        if (DeletedFlag.IsSet(document.RootElement)) return [];

        var openSlots = OpenSlots(container, containerType, document.RootElement, schemas, release);
        return [.. adds
            .Where(add => Allows(add.Narrowing, place) && schemas.ContainsKey(add.Type))
            .Where(add => dispatch.ConcreteFor(add.Type) is { } held
                && openSlots.Exists(slot => slot.Any(type => type.IsAssignableFrom(held))))
            .Select(add => add.Type)];
    }

    /// <summary>The members of <paramref name="containerType"/> a record of <paramref name="recordType"/>
    /// can sit in. A placed reference has two in a cell: its persistent and its temporary children.</summary>
    public static IReadOnlyList<string> SlotsFor(string containerType, string recordType, GameRelease release)
    {
        var dispatch = RecordTypeDispatch.For(release);
        if (dispatch.ConcreteFor(containerType) is not { } container || dispatch.ConcreteFor(recordType) is not { } held) return [];
        var category = release.ToCategory();
        return [.. ContainerMembers.Derived.HeldTypesBySlot
            .Where(slot => slot.Key.Game == category && slot.Key.ParentType == container.Name)
            .Where(slot => slot.Value.Any(type => type.IsAssignableFrom(held)))
            .Select(slot => slot.Key.Slot)];
    }

    private static bool Allows(Narrowing narrowing, CellPlace? place) => narrowing switch
    {
        Narrowing.NotPersistent => place is not CellPlace.PersistentWorldspaceCell,
        Narrowing.Exterior => place is CellPlace.Exterior,
        _ => true,
    };

    // A member holding a single record is open only while it holds none.
    private static List<IReadOnlyList<Type>> OpenSlots(
        Type container, string containerType, JsonElement document,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        var filled = new ContainerDocuments(release, schemas).ChildrenOf(containerType, document)
            .Select(child => child.SlotName)
            .ToHashSet(StringComparer.Ordinal);
        var category = release.ToCategory();
        return
        [
            .. ContainerMembers.Derived.HeldTypesBySlot
                .Where(slot => slot.Key.Game == category && slot.Key.ParentType == container.Name)
                .Where(slot => !filled.Contains(slot.Key.Slot) || HoldsAList(container, slot.Key.Slot))
                .Select(slot => slot.Value),
        ];
    }

    private static bool HoldsAList(Type container, string slot) =>
        container.GetProperty(slot) is { } property
        && typeof(System.Collections.IEnumerable).IsAssignableFrom(property.PropertyType);
}
