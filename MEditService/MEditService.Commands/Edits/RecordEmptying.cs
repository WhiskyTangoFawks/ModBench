using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>xEdit's Delete, MakePartialForm and their undoing, which refills the copy from the nearest
/// copy to its left that is neither. TwbRecordHeaderStruct.ElementChanged applies Partial Form last, so
/// making one of a deleted copy refills it first.</summary>
internal sealed record RecordEmptying(JsonElement Flags, bool Deletes, bool MakesPartialForm, bool Refills, bool HeldPersistent)
{
    /// <summary>The emptying a write of <paramref name="value"/> makes, or null when it newly sets and
    /// clears neither flag.</summary>
    internal static RecordEmptying? Of(JsonObject record, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write) return null;
        var partialFormable = PartialFormFlag.IsPartialFormable(schema.RecordType);
        var makesPartialForm = partialFormable && write.Sets(PartialFormFlag.Bit);
        var deletes = !makesPartialForm && write.Sets(DeletedFlag.Bit);
        var flags = write.Next;
        if (makesPartialForm) flags &= ~DeletedFlag.Bit;
        else if (deletes && partialFormable) flags &= ~PartialFormFlag.Bit;
        var refills = !deletes && ((write.Held & ~flags & EmptyingBits(schema)) != 0 || write.Sets(DeletedFlag.Bit));
        if (!deletes && !makesPartialForm && !refills) return null;
        var heldPersistent = (write.Held & PersistentFlag.Bit) != 0;
        return new(JsonSerializer.SerializeToElement(flags), deletes, makesPartialForm, refills, heldPersistent);
    }

    /// <summary>Whether a write of <paramref name="envelope"/> refills the record at
    /// <paramref name="prefix"/>, and so needs its nearest copy to the left that is neither.</summary>
    internal static bool RefillsFromTheLeft(
        string text, IReadOnlyList<PathHop> prefix, RecordEditEnvelope envelope, RecordTableSchema schema)
    {
        if (envelope.Path is not [{ Name: RecordHeaderFlags.Member }]) return false;
        if (schema.RecordColumns.FirstOrDefault(c => c.Name == RecordHeaderFlags.Member) is not { } column) return false;
        return EmbeddedChildPath.Walk(JsonNode.Parse(text), prefix) is JsonObject record
            && Of(record, schema, column, envelope.Value) is { Refills: true };
    }

    /// <summary>The flags a copy a refill takes its fields from holds neither of.</summary>
    internal static long EmptyingBits(RecordTableSchema schema) =>
        PartialFormFlag.IsPartialFormable(schema.RecordType) ? DeletedFlag.Bit | PartialFormFlag.Bit : DeletedFlag.Bit;

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

    internal void Apply(JsonObject record, RecordTableSchema schema, string? copyOnTheLeft)
    {
        var left = Refills && copyOnTheLeft != null ? JsonNode.Parse(copyOnTheLeft) as JsonObject : null;
        foreach (var member in OwnFields(schema))
        {
            var fromTheLeft = Refills && (!MakesPartialForm || member == RecordMembers.EditorId);
            if (fromTheLeft && left?[member] is { } value) record[member] = value.DeepClone();
            else if (fromTheLeft || Deletes || member != RecordMembers.EditorId) record.Remove(member);
        }
    }

    private static IEnumerable<string> OwnFields(RecordTableSchema schema)
    {
        var children = ContainerChildFields.EnumerateChildFieldsFor(schema.RecordType) ?? [];
        return schema.RecordColumns
            .Where(c => !c.Field.IsRecordHeaderMember && !c.Field.IsDiscriminator)
            .Select(c => c.PropertyName)
            .Where(name => !children.Contains(name, StringComparer.Ordinal))
            .Append(RecordMembers.EditorId);
    }
}
