using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

namespace MEditService.Commands.Edits;

/// <summary>A Record Flags write newly setting Partial Form or Deleted is xEdit's MakePartialForm or
/// Delete: each keeps the header, children and kind, and clears the other flag. Partial Form wins
/// both, as TwbRecordHeaderStruct.ElementChanged applies it last.</summary>
internal sealed record RecordEmptying(JsonElement Flags, bool KeepsEditorId)
{
    /// <summary>The emptying a write of <paramref name="value"/> makes, or null when it newly sets neither flag.</summary>
    internal static RecordEmptying? Of(JsonObject record, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write) return null;
        var partialFormable = PartialFormFlag.IsPartialFormable(schema.RecordType);
        if (partialFormable && write.Sets(PartialFormFlag.Bit))
            return new(JsonSerializer.SerializeToElement(write.Next & ~DeletedFlag.Bit), KeepsEditorId: true);
        if (!write.Sets(DeletedFlag.Bit)) return null;
        return new(JsonSerializer.SerializeToElement(partialFormable ? write.Next & ~PartialFormFlag.Bit : write.Next), KeepsEditorId: false);
    }

    internal void EmptyFields(JsonObject record, RecordTableSchema schema)
    {
        var children = ContainerChildFields.EnumerateChildFieldsFor(schema.RecordType) ?? [];
        foreach (var column in schema.RecordColumns)
        {
            if (column.Field.IsRecordHeaderMember || column.Field.IsDiscriminator) continue;
            if (!children.Contains(column.PropertyName, StringComparer.Ordinal)) record.Remove(column.PropertyName);
        }
        if (!KeepsEditorId) record.Remove(RecordMembers.EditorId);
    }
}
