using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A Record Flags write that changes Persistent on a placed record moves it into the group
/// the new bit names, of its own cell or of another, as xEdit's TwbMainRecord.UpdateCellChildGroup does.</summary>
internal sealed record CellGroupMove(IReadOnlyList<PathHop> Prefix, string Destination)
{
    /// <summary>The move a write of <paramref name="value"/> makes on the record at
    /// <paramref name="prefix"/>, or null when it leaves Persistent as it was.</summary>
    internal static CellGroupMove? Of(
        JsonObject record, IReadOnlyList<PathHop> prefix, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (!IsPlaced(prefix)) return null;
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write || !write.Changes(PersistentFlag.Bit)) return null;
        return new(prefix, (write.Next & PersistentFlag.Bit) != 0 ? PersistentFlag.PersistentGroup : PersistentFlag.TemporaryGroup);
    }

    /// <summary>Whether the record at <paramref name="prefix"/> sits in one of its cell's groups.</summary>
    internal static bool IsPlaced(IReadOnlyList<PathHop> prefix) =>
        prefix is [.., { Kind: PathHop.MemberKind, Name: PersistentFlag.PersistentGroup or PersistentFlag.TemporaryGroup }, _];

    private IReadOnlyList<PathHop> CellPrefix => [.. Prefix.Take(Prefix.Count - 2)];

    private bool IntoPersistent => Destination == PersistentFlag.PersistentGroup;

    /// <summary>A cell whose own copy says nothing of where it sits, on a Record Flags write: its nearest
    /// copy to the left decides, as xEdit reads the highest override visible to the file.</summary>
    internal static string? CellToLookUp(JsonObject root, IReadOnlyList<PathHop> prefix, RecordEditEnvelope envelope)
    {
        if (envelope.Path is not [{ Name: RecordHeaderFlags.Member }]) return null;
        if (!IsPlaced(prefix)) return null;
        var cellPrefix = prefix.Take(prefix.Count - 2).ToList();
        if (cellPrefix is [.., { Name: PlacedCell.WorldspacePersistentCellMember }]) return null;
        return EmbeddedChildPath.Walk(root, cellPrefix) is JsonObject cell && !PlacedCell.Says(cell)
            ? cell[RecordMembers.FormKey]?.GetValue<string>()
            : null;
    }

    /// <summary>The cell the record leaves its own for, in <paramref name="into"/>. Its own keeps it when
    /// interior, when it is the persistent cell taking it in, or when its grid holds the record's position.</summary>
    internal RecordEditResult? RefuseUnknownCell(
        JsonObject root, GameRelease release, LeftCopy? cellCopyOnTheLeft, string spelled, out AnotherCell? into)
    {
        into = null;
        var cell = Cell(root);
        var record = EmbeddedChildPath.Walk(root, Prefix) as JsonObject
            ?? throw new InvalidOperationException($"The document has no record at {RecordEditEnvelope.Spell(Prefix)}.");
        var formKey = record[RecordMembers.FormKey]?.GetValue<string>();
        var inThePersistentCell = CellPrefix is [.., { Name: PlacedCell.WorldspacePersistentCellMember }];
        (int X, int Y)? grid = null;
        if (!inThePersistentCell)
        {
            if (PlacedCell.SaidBy(cell, cellCopyOnTheLeft?.FoundText) is not { } said)
            {
                if (cellCopyOnTheLeft is LeftCopy.Unreadable unreadable)
                    return unreadable.Refusal(spelled, $"which cell xEdit would move {formKey} into depends on where its cell sits, which only that cell's nearest copy to the left says");
                return Unknown(
                    spelled, formKey,
                    $"its cell {cell[RecordMembers.FormKey]?.GetValue<string>()} says neither that it is interior nor where it " +
                    "sits in its worldspace, and no copy of it to its left says either");
            }
            if (PlacedCell.IsInterior(said)) return null;
            grid = PlacedCell.Grid(said);
        }
        if (IntoPersistent)
        {
            if (!inThePersistentCell) into = new AnotherCell.PersistentCell();
            return null;
        }
        if (PlacedCell.GridHolding(record, release) is not { } holding)
            return Unknown(spelled, formKey, "it has no position mEdit can place in a grid cell");
        if (holding != grid) into = new AnotherCell.GridCell(holding.X, holding.Y);
        return null;
    }

    internal static RecordEditResult Unknown(string spelled, string? formKey, string why) =>
        RecordEditResult.RefusedAt(
            RecordEditRefusal.PersistentMoveDestinationUnknown, spelled,
            $"Which cell xEdit would move {formKey} into is unknown: {why}. Nothing was written.");

    /// <summary>Moves the record to the end of its cell's destination group; returns its new prefix.</summary>
    internal IReadOnlyList<PathHop> Apply(JsonObject root)
    {
        if (Prefix[^2].Name == Destination) return Prefix;
        var cell = Cell(root);
        var source = cell[Prefix[^2].RequireName()] as JsonArray
            ?? throw new InvalidOperationException($"The document has no group at {RecordEditEnvelope.Spell(Prefix.Take(Prefix.Count - 1))}.");
        var record = source[Prefix[^1].RequireIndex()];
        source.RemoveAt(Prefix[^1].RequireIndex());
        if (cell[Destination] is not JsonArray destination) cell[Destination] = destination = [];
        destination.Add(record);
        return [.. CellPrefix, PathHop.Member(Destination), PathHop.At(destination.Count - 1)];
    }

    private JsonObject Cell(JsonObject root) =>
        EmbeddedChildPath.Walk(root, CellPrefix) as JsonObject
            ?? throw new InvalidOperationException($"The document has no cell at {RecordEditEnvelope.Spell(CellPrefix)}.");
}

/// <summary>A cell other than the placed record's own that a change to Persistent moves it into.</summary>
internal abstract record AnotherCell
{
    private AnotherCell(string group) => Group = group;

    /// <summary>The group of the cell the record lands in.</summary>
    internal string Group { get; }

    /// <summary>The worldspace's persistent cell, on set.</summary>
    internal sealed record PersistentCell() : AnotherCell(PersistentFlag.PersistentGroup);

    /// <summary>The exterior cell whose grid holds the record's position, on clear.</summary>
    internal sealed record GridCell(int X, int Y) : AnotherCell(PersistentFlag.TemporaryGroup);
}

/// <summary>A placed record a write moves out of its document's cell, at <see cref="Prefix"/> there,
/// and the cell it lands in.</summary>
internal sealed record CellCrossing(IReadOnlyList<PathHop> Prefix, AnotherCell Into);
