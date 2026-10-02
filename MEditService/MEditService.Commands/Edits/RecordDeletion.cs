using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

namespace MEditService.Commands.Edits;

/// <summary>Setting Deleted through Record Flags is xEdit's Delete (TwbMainRecord.Delete): the
/// record keeps its header and children and stops being a Partial Form. Mutagen writes a deleted
/// record as its header alone.</summary>
internal static class RecordDeletion
{
    private const string FlagsMember = "MajorRecordFlagsRaw";

    // Mutagen's Constants.DeletedFlag, which Mutagen keeps internal.
    private const long DeletedBit = 0x20;

    /// <summary>The flags to write instead of <paramref name="value"/> when it newly sets Deleted;
    /// null for every other write.</summary>
    internal static JsonElement? FlagsSettingDeleted(
        JsonObject record, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (schema.IsHeader || column.Name != FlagsMember || value is not { ValueKind: JsonValueKind.Number } requested) return null;
        var held = record[FlagsMember] is JsonValue raw && raw.TryGetValue<long>(out var flags) ? flags : 0;
        var next = requested.GetInt64();
        if ((next & DeletedBit) == 0 || (held & DeletedBit) != 0) return null;
        if (PartialFormFlag.IsPartialFormable(schema.RecordType)) next &= ~PartialFormFlag.Bit;
        return JsonSerializer.SerializeToElement(next);
    }

    /// <summary>Removes every field: all but the record header, the children and the record's kind.</summary>
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
