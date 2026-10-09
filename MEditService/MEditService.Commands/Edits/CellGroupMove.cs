using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A Record Flags write that changes Persistent on a placed record moves it into the group
/// the new bit names, of its own cell or of <see cref="Into"/> another, as xEdit's TwbMainRecord.UpdateCellChildGroup does.</summary>
internal sealed record CellGroupMove(HeldIn From, string Destination, AnotherCell? Into = null)
{
    /// <summary>The move a write of <paramref name="value"/> makes on the record <paramref name="held"/>
    /// holds, or null when it leaves Persistent as it was.</summary>
    internal static CellGroupMove? Of(
        JsonObject record, HeldIn? held, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (held is not { IsPlaced: true } placed) return null;
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write || !write.Changes(PersistentFlag.Bit)) return null;
        return new(placed, (write.Next & PersistentFlag.Bit) != 0 ? PersistentFlag.PersistentGroup : PersistentFlag.TemporaryGroup);
    }

    /// <summary>Whether the record moves into another group of its own cell.</summary>
    internal bool StaysInItsCell => Into is null && Destination != From.Slot;

    private bool IntoPersistent => Destination == PersistentFlag.PersistentGroup;

    /// <summary>The cell <paramref name="record"/> leaves its own for, in <paramref name="into"/>. Its own keeps it when
    /// interior, when it is the persistent cell taking it in, or when its grid holds the record's position.</summary>
    internal RecordEditResult? RefuseUnknownCell(
        JsonObject record, GameRelease release, LoadOrderResolution.MastersWalk masters, string spelled, out AnotherCell? into)
    {
        into = null;
        var cell = JsonNode.Parse(From.Container.Body) as JsonObject
            ?? throw new InvalidOperationException($"Expected the own text of {From.Container.FormKey} to hold a JSON object.");
        var formKey = record[RecordMembers.FormKey]?.GetValue<string>();
        var inThePersistentCell = From.ContainerHeldIn is { IsThePersistentCell: true };
        (int X, int Y)? grid = null;
        if (!inThePersistentCell)
        {
            if (masters.WhereItSits(
                cell, spelled,
                $"which cell xEdit would move {formKey} into depends on where its cell sits, which only that cell's nearest copy to the left says",
                () => Unknown(
                    spelled, formKey,
                    $"its cell {cell[RecordMembers.FormKey]?.GetValue<string>()} says neither that it is interior nor where it " +
                    "sits in its worldspace, and no copy of it to its left says either"),
                out var said) is { } refusal)
                return refusal;
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
