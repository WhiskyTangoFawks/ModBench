using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

namespace MEditService.Commands.Edits;

/// <summary>A Record Flags write that newly sets Deleted is xEdit's Delete (TwbMainRecord.Delete):
/// the record keeps its header, children and kind, and stops being a Partial Form. Mutagen writes a
/// deleted record as its header alone.</summary>
internal sealed record RecordDeletion(JsonElement Flags, bool ClearsPartialForm)
{
    /// <summary>The deletion a write of <paramref name="value"/> makes, or null when it does not
    /// newly set Deleted.</summary>
    internal static RecordDeletion? Of(JsonObject record, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write || !write.Sets(DeletedFlag.Bit)) return null;
        var clearsPartialForm = PartialFormFlag.IsSet(JsonSerializer.SerializeToElement(record), schema.RecordType);
        return new(JsonSerializer.SerializeToElement(clearsPartialForm ? write.Next & ~PartialFormFlag.Bit : write.Next), clearsPartialForm);
    }

    /// <summary>Whether this deletion, rather than the value written, changes <paramref name="bit"/>.</summary>
    internal bool Changes(SyntheticBit bit) => ClearsPartialForm && bit.Bit == PartialFormFlag.Bit;

    internal static void EmptyFields(JsonObject record, RecordTableSchema schema)
    {
        var children = ContainerChildFields.EnumerateChildFieldsFor(schema.RecordType) ?? [];
        foreach (var column in schema.RecordColumns)
        {
            if (column.Synthetic != null || column.Field.IsRecordHeaderMember || column.Field.IsDiscriminator) continue;
            if (!children.Contains(column.PropertyName, StringComparer.Ordinal)) record.Remove(column.PropertyName);
        }
        record.Remove(RecordMembers.EditorId);
    }
}
