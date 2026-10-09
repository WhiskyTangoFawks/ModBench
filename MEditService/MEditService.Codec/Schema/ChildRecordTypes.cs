using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>Where a cell sits, which narrows what xEdit's Add offers on it.</summary>
public enum CellPlace { Interior, Exterior, PersistentWorldspaceCell }

/// <summary>What xEdit's Add lists on a container record, among the types an open member of it holds
/// in the game. A type the game lacks is left out.</summary>
public static class ChildRecordTypes
{
    private enum Narrowing { None, NotPersistent, NotPersistentExterior }

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
                ("land", Narrowing.NotPersistentExterior), ("pgrd", Narrowing.NotPersistent), ("navm", Narrowing.NotPersistent),
            ],
        };

    /// <summary><paramref name="containerText"/> is the container's own document, which says whether it
    /// is deleted and which single-record members are filled. <paramref name="place"/> is null for a
    /// container that is no cell.</summary>
    public static IReadOnlyList<string> Of(
        string containerType, string containerText, CellPlace? place,
        GameRelease release)
    {
        if (!XEditAddList.TryGetValue(containerType, out var adds)) return [];
        using var document = JsonDocument.Parse(containerText);
        var container = Read(containerType, document.RootElement, release);
        return [.. adds
            .Where(add => SlotFor(add, place, container, release) is ChildSlot.Open or ChildSlot.Several)
            .Select(add => add.Type)];
    }

    /// <summary>Where a new <paramref name="recordType"/> lands in the container, as Of reads it;
    /// <see cref="ChildSlot.Filled"/> only when a held single-record member is all that stands in the way.</summary>
    public static ChildSlot SlotFor(
        string containerType, string containerText, CellPlace? place, string recordType,
        GameRelease release)
    {
        if (!XEditAddList.TryGetValue(containerType, out var adds)
            || adds.Where(add => add.Type.Equals(recordType, StringComparison.OrdinalIgnoreCase)).ToList() is not [var offered])
            return new ChildSlot.NotHeld();
        using var document = JsonDocument.Parse(containerText);
        return SlotFor(offered, place, Read(containerType, document.RootElement, release), release);
    }

    private static ChildSlot SlotFor(
        (string Type, Narrowing Narrowing) add, CellPlace? place, Container container,
        GameRelease release)
    {
        if (!Allows(add.Narrowing, place, container.Persistent)
            || RecordTypes.For(release).ConcreteFor(add.Type) is not { } held) return new ChildSlot.NotHeld();

        var takers = container.Members.Where(member => member.Holds.Any(type => type.IsAssignableFrom(held))).ToList();
        return takers.Where(member => member.HeldBy is null).ToList() switch
        {
            [var only] => new ChildSlot.Open(only.Slot),
            [] => takers is [{ HeldBy: { } heldBy } filled, ..] ? new ChildSlot.Filled(filled.Slot, heldBy) : new ChildSlot.NotHeld(),
            var open when PlacedGroup(open, container.Persistent) is { } group => new ChildSlot.Open(group),
            var open => new ChildSlot.Several([.. open.Select(member => member.Slot)]),
        };
    }

    // TwbGroupRecord.Add (wbImplementation.pas) lands a cell's placed record in its persistent group when
    // the cell carries the Persistent flag, and in its temporary group otherwise.
    private static string? PlacedGroup(List<Member> open, bool persistent)
    {
        if (!open.Any(member => member.Slot == PersistentFlag.PersistentGroup)
            || !open.Any(member => member.Slot == PersistentFlag.TemporaryGroup)) return null;
        return persistent ? PersistentFlag.PersistentGroup : PersistentFlag.TemporaryGroup;
    }

    // HeldBy names what fills a single-record member, which is then closed; a list member stays open.
    private sealed record Member(string Slot, IReadOnlyList<Type> Holds, string? HeldBy);

    private sealed record Container(IReadOnlyList<Member> Members, bool Persistent);

    private static Container Read(
        string containerType, JsonElement root, GameRelease release) =>
        new(MembersOf(containerType, root, release), PersistentFlag.IsSet(root));

    // None for a deleted container: it holds nothing.
    private static List<Member> MembersOf(
        string containerType, JsonElement root, GameRelease release)
    {
        if (RecordTypes.For(release).ConcreteFor(containerType) is not { } container) return [];
        if (DeletedFlag.IsSet(root)) return [];

        var held = new ContainerDocuments(release).ChildrenOf(containerType, root)
            .GroupBy(child => child.SlotName, StringComparer.Ordinal)
            .ToDictionary(slot => slot.Key, slot => slot.First().FormKey, StringComparer.Ordinal);
        var category = release.ToCategory();
        return [.. ContainerMembers.Derived.HeldTypesBySlot
            .Where(slot => slot.Key.Game == category && slot.Key.ParentType == container.Name)
            .Select(slot => new Member(
                slot.Key.Slot, slot.Value, HoldsAList(container, slot.Key.Slot) ? null : held.GetValueOrDefault(slot.Key.Slot)))];
    }

    private static bool Allows(Narrowing narrowing, CellPlace? place, bool persistent) => narrowing switch
    {
        Narrowing.NotPersistent => !persistent,
        Narrowing.NotPersistentExterior => !persistent && place is CellPlace.Exterior,
        _ => true,
    };

    private static bool HoldsAList(Type container, string slot) =>
        container.GetProperty(slot) is { } property
        && typeof(System.Collections.IEnumerable).IsAssignableFrom(property.PropertyType);
}

/// <summary>Where a new child record lands in its container.</summary>
public abstract record ChildSlot
{
    private ChildSlot()
    {
    }

    /// <summary>The one member it lands at the end of.</summary>
    public sealed record Open(string Slot) : ChildSlot;

    /// <summary>The single-record member that would take it already holds <paramref name="HeldFormKey"/>.</summary>
    public sealed record Filled(string Slot, string HeldFormKey) : ChildSlot;

    /// <summary>More than one member takes it.</summary>
    internal sealed record Several(IReadOnlyList<string> Slots) : ChildSlot;

    /// <summary>xEdit's Add offers no such record on the container where it sits.</summary>
    public sealed record NotHeld : ChildSlot
    {
        internal NotHeld()
        {
        }
    }
}
