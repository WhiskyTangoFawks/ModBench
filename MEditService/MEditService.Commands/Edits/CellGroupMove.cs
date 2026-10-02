using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;

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
        if (schema.IsHeader || column.Name != DeletedFlag.FlagsMember || value is not { ValueKind: JsonValueKind.Number } requested)
            return null;
        if (prefix is not [.., { Kind: PathHop.MemberKind, Name: PersistentFlag.PersistentGroup or PersistentFlag.TemporaryGroup } group, _])
            return null;
        var held = record[DeletedFlag.FlagsMember] is JsonValue raw && raw.TryGetValue<long>(out var flags) ? flags : 0;
        var next = requested.GetInt64();
        if (((held ^ next) & PersistentFlag.Bit) == 0) return null;
        var destination = (next & PersistentFlag.Bit) != 0 ? PersistentFlag.PersistentGroup : PersistentFlag.TemporaryGroup;
        return destination == group.Name ? null : new(prefix, destination);
    }

    private IReadOnlyList<PathHop> CellPrefix => [.. Prefix.Take(Prefix.Count - 2)];

    /// <summary>xEdit keeps the record in its cell only when that cell is interior, or is a
    /// worldspace's persistent cell taking it in; every other move it makes is into another cell.</summary>
    internal RecordEditResult? RefuseLeavingTheCell(JsonObject root, Func<string, CellPlacement?> placementOf, string spelled)
    {
        var cellFormKey = Cell(root)[RecordMembers.FormKey]?.GetValue<string>();
        var placement = cellFormKey == null ? null : placementOf(cellFormKey);
        if (placement is { IsInterior: true }) return null;
        if (Destination == PersistentFlag.PersistentGroup && placement is { BlockX: null }) return null;
        var (change, into) = Destination == PersistentFlag.PersistentGroup
            ? ("Setting", "its worldspace's persistent cell")
            : ("Clearing", "the exterior cell at its position");
        return RecordEditResult.RefusedAt(
            RecordEditRefusal.PersistentMoveIntoAnotherCell, spelled,
            $"{change} Persistent on a placed record in {cellFormKey} moves it into {into} in xEdit, and mEdit " +
            "does not move a record into another cell. Nothing was written.");
    }

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
