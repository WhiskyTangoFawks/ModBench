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
internal sealed record RecordEmptying(long Flags, bool Deletes, bool MakesPartialForm, bool Refills, bool HeldPersistent)
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
        var clears = !deletes && (write.Held & ~flags & EmptyingBits(schema)) != 0;
        var deletesBeforeMakingPartialForm = makesPartialForm && write.Sets(DeletedFlag.Bit);
        var refills = clears || deletesBeforeMakingPartialForm;
        if (!deletes && !makesPartialForm && !refills) return null;
        var heldPersistent = (write.Held & PersistentFlag.Bit) != 0;
        return new(flags, deletes, makesPartialForm, refills, heldPersistent);
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

    /// <summary>The flags a copy a refill passes over: Deleted, and Partial Form where the type can be one.</summary>
    internal static long EmptyingBits(RecordTableSchema schema) =>
        PartialFormFlag.IsPartialFormable(schema.RecordType) ? DeletedFlag.Bit | PartialFormFlag.Bit : DeletedFlag.Bit;

    /// <summary>The refusal of a refill whose nearest copy to the left cannot be read.</summary>
    internal RecordEditResult? RefuseRefill(LeftCopy? copyOnTheLeft, RecordTableSchema schema, string? formKey, string spelled)
    {
        if (!Refills || copyOnTheLeft is not LeftCopy.Unreadable unreadable) return null;
        var neither = PartialFormFlag.IsPartialFormable(schema.RecordType) ? "neither Partial Form nor Deleted" : "not Deleted";
        return unreadable.Refusal(spelled, $"{formKey}'s own fields come from its nearest copy to the left that is {neither}");
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
        LeftCopy? cellCopyOnTheLeft, string spelled)
    {
        if (!MakesPartialForm || !RecordTypeDispatch.For(release).IsCell(schema.TableName)) return null;
        var formKey = record[RecordMembers.FormKey]?.GetValue<string>();
        if (!HeldPersistent && prefix is not [.., { Name: PlacedCell.WorldspacePersistentCellMember }])
        {
            if (PlacedCell.SaidBy(record, cellCopyOnTheLeft?.FoundText) is not { } said)
            {
                if (cellCopyOnTheLeft is LeftCopy.Unreadable unreadable)
                    return unreadable.Refusal(spelled, $"whether {formKey} can be a Partial Form depends on where it sits, which only its nearest copy to the left says");
                return Cannot(spelled, $"whether {formKey} can be a Partial Form is unknown: it says neither that it is " +
                    "interior nor where it sits in its worldspace, and no copy of it to its left says either");
            }
            if (!PlacedCell.IsInterior(said)) return Cannot(spelled, $"{formKey} is a temporary exterior cell, which xEdit never makes a Partial Form");
        }
        if (PartialFormFlag.CellsDefinedIn(release) is { } plugin && FormKey.TryFactory(formKey, out var key) && key.ModKey != plugin)
            return Cannot(spelled, $"{key.ModKey} defines {formKey}, and xEdit makes a cell a Partial Form only where {plugin} defines it");
        return null;
    }

    private static RecordEditResult Cannot(string spelled, string why) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.CannotBePartialForm, spelled, $"'{spelled}': {why}. Nothing was written.");

    /// <summary>xEdit's AssignInternal copies the left copy's flags; Delete and MakePartialForm clear Compressed.</summary>
    internal JsonElement FlagsWith(JsonObject? left)
    {
        var flags = Flags;
        if (left != null) flags = RecordFlagsWrite.HeldBy(left);
        if (left != null && MakesPartialForm) flags |= PartialFormFlag.Bit;
        if (Deletes || MakesPartialForm) flags &= ~CompressedFlag.Bit;
        return JsonSerializer.SerializeToElement(flags);
    }

    internal void Apply(JsonObject record, RecordTableSchema schema, JsonObject? left)
    {
        foreach (var member in OwnFields(schema))
        {
            var fromTheLeft = Refills && (!MakesPartialForm || member == RecordMembers.EditorId);
            if (fromTheLeft && left?[member] is { } value) record[member] = value.DeepClone();
            else if (fromTheLeft || Deletes || member != RecordMembers.EditorId) record.Remove(member);
        }
        if (left?[RecordMembers.FormVersion] is { } formVersion) record[RecordMembers.FormVersion] = formVersion.DeepClone();
        else if (left != null) record.Remove(RecordMembers.FormVersion);
    }

    internal JsonObject? LeftOf(LeftCopy? copyOnTheLeft) =>
        Refills && copyOnTheLeft?.FoundText is { } text ? JsonNode.Parse(text) as JsonObject : null;

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
