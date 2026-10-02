using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>A Record Flags write newly setting Partial Form or Deleted is xEdit's MakePartialForm or
/// Delete: each keeps the header, children and kind, and clears the other flag. Partial Form wins
/// both, as TwbRecordHeaderStruct.ElementChanged applies it last.</summary>
internal sealed record RecordEmptying(JsonElement Flags, bool MakesPartialForm, bool HeldPersistent)
{
    /// <summary>The emptying a write of <paramref name="value"/> makes, or null when it newly sets neither flag.</summary>
    internal static RecordEmptying? Of(JsonObject record, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write) return null;
        var partialFormable = PartialFormFlag.IsPartialFormable(schema.RecordType);
        var heldPersistent = (write.Held & PersistentFlag.Bit) != 0;
        if (partialFormable && write.Sets(PartialFormFlag.Bit))
            return new(JsonSerializer.SerializeToElement(write.Next & ~DeletedFlag.Bit), MakesPartialForm: true, heldPersistent);
        if (!write.Sets(DeletedFlag.Bit)) return null;
        var flags = partialFormable ? write.Next & ~PartialFormFlag.Bit : write.Next;
        return new(JsonSerializer.SerializeToElement(flags), MakesPartialForm: false, heldPersistent);
    }

    /// <summary>The cell whose nearest copy to the left says where it sits, on a write that may make a cell
    /// that does not say so itself a Partial Form.</summary>
    internal static string? CellToLookUp(
        string text, IReadOnlyList<PathHop> prefix, RecordEditEnvelope envelope, RecordTableSchema schema, GameRelease release)
    {
        if (envelope.Path is not [{ Name: RecordHeaderFlags.Member }]) return null;
        if (envelope.Value is not { ValueKind: JsonValueKind.Number } value || (value.GetInt64() & PartialFormFlag.Bit) == 0) return null;
        if (!RecordTypeDispatch.For(release).IsCell(schema.TableName)) return null;
        var cell = EmbeddedChildPath.Walk(JsonNode.Parse(text), prefix) as JsonObject;
        return cell is null || PlacedCell.Says(cell) ? null : cell[RecordMembers.FormKey]?.GetValue<string>();
    }

    /// <summary>xEdit's GetCanBePartial: a temporary exterior cell is never a Partial Form, nor a cell a
    /// plugin other than the one the game names defines.</summary>
    internal RecordEditResult? RefuseCell(
        JsonObject record, IReadOnlyList<PathHop> prefix, RecordTableSchema schema, GameRelease release,
        string? cellCopyOnTheLeft, string spelled)
    {
        if (!MakesPartialForm || !RecordTypeDispatch.For(release).IsCell(schema.TableName)) return null;
        var formKey = record[RecordMembers.FormKey]?.GetValue<string>();
        if (!HeldPersistent && prefix is not [.., { Name: PlacedCell.WorldspacePersistentCellMember }])
        {
            if (PlacedCell.SaidBy(record, cellCopyOnTheLeft) is not { } said)
            {
                return Cannot(spelled, $"whether {formKey} can be a Partial Form is unknown: it says neither that it is " +
                    "interior nor where it sits in its worldspace, and no copy of it to its left that mEdit can read says either");
            }
            if (!PlacedCell.IsInterior(said)) return Cannot(spelled, $"{formKey} is a temporary exterior cell, which xEdit never makes a Partial Form");
        }
        if (PartialFormFlag.CellsDefinedIn(release) is { } plugin && FormKey.TryFactory(formKey, out var key) && key.ModKey != plugin)
            return Cannot(spelled, $"{key.ModKey} defines {formKey}, and xEdit makes a cell a Partial Form only where {plugin} defines it");
        return null;
    }

    private static RecordEditResult Cannot(string spelled, string why) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.CannotBePartialForm, spelled, $"'{spelled}': {why}. Nothing was written.");

    internal void EmptyFields(JsonObject record, RecordTableSchema schema)
    {
        var children = ContainerChildFields.EnumerateChildFieldsFor(schema.RecordType) ?? [];
        foreach (var column in schema.RecordColumns)
        {
            if (column.Field.IsRecordHeaderMember || column.Field.IsDiscriminator) continue;
            if (!children.Contains(column.PropertyName, StringComparer.Ordinal)) record.Remove(column.PropertyName);
        }
        if (!MakesPartialForm) record.Remove(RecordMembers.EditorId);
    }
}
