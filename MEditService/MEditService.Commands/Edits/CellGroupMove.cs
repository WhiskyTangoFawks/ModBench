using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A Record Flags write that changes Persistent on a placed record moves it into the group
/// of its cell the new bit names, as xEdit's TwbMainRecord.UpdateCellChildGroup does.</summary>
internal sealed record CellGroupMove(IReadOnlyList<PathHop> Prefix, string Destination)
{
    /// <summary>The move a write of <paramref name="value"/> makes on the record at
    /// <paramref name="prefix"/>, or null when it leaves the record in its group.</summary>
    internal static CellGroupMove? Of(
        JsonObject record, IReadOnlyList<PathHop> prefix, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (prefix is not [.., { Kind: PathHop.MemberKind, Name: PersistentFlag.PersistentGroup or PersistentFlag.TemporaryGroup } group, _])
            return null;
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write || !write.Changes(PersistentFlag.Bit)) return null;
        var destination = (write.Next & PersistentFlag.Bit) != 0 ? PersistentFlag.PersistentGroup : PersistentFlag.TemporaryGroup;
        return destination == group.Name ? null : new(prefix, destination);
    }

    private IReadOnlyList<PathHop> CellPrefix => [.. Prefix.Take(Prefix.Count - 2)];

    private bool IntoPersistent => Destination == PersistentFlag.PersistentGroup;

    /// <summary>xEdit keeps the record in its cell when that cell is interior, is a worldspace's
    /// persistent cell taking it in, or is the exterior cell its position falls in.</summary>
    internal RecordEditResult? RefuseLeavingTheCell(JsonObject root, GameRelease release, string spelled)
    {
        var cell = Cell(root);
        var record = EmbeddedChildPath.Walk(root, Prefix) as JsonObject
            ?? throw new InvalidOperationException($"The document has no record at {RecordEditEnvelope.Spell(Prefix)}.");
        var formKey = record[RecordMembers.FormKey]?.GetValue<string>();
        if (PlacedCell.IsInterior(cell)) return null;
        if (CellPrefix is [.., { Name: PlacedCell.WorldspacePersistentCellMember }])
            return IntoPersistent ? null : IntoAnotherCell(spelled, formKey);
        if (PlacedCell.Grid(cell) is not { } grid)
        {
            return Unknown(
                spelled, formKey,
                $"its cell {cell[RecordMembers.FormKey]?.GetValue<string>()} says neither that it is interior nor where it sits in its worldspace");
        }
        if (IntoPersistent) return IntoAnotherCell(spelled, formKey);
        if (PlacedCell.GridHolding(record, release) is not { } holding)
            return Unknown(spelled, formKey, "it has no position mEdit can place in a grid cell");
        return holding == grid ? null : IntoAnotherCell(spelled, formKey);
    }

    private RecordEditResult IntoAnotherCell(string spelled, string? formKey) =>
        RecordEditResult.RefusedAt(
            RecordEditRefusal.PersistentMoveIntoAnotherCell, spelled,
            (IntoPersistent
                ? $"Setting Persistent on {formKey} moves it into its worldspace's persistent cell in xEdit"
                : $"Clearing Persistent on {formKey} moves it into the exterior cell at its position in xEdit")
            + ", and mEdit does not move a record into another cell. Nothing was written.");

    private static RecordEditResult Unknown(string spelled, string? formKey, string why) =>
        RecordEditResult.RefusedAt(
            RecordEditRefusal.PersistentMoveIntoAnotherCell, spelled,
            $"Which cell xEdit would move {formKey} into is unknown: {why}. Nothing was written.");

    /// <summary>Moves the record to the end of its cell's destination group; returns its new prefix.</summary>
    internal IReadOnlyList<PathHop> Apply(JsonObject root)
    {
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
