using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;

namespace MEditService.Commands.Edits;

/// <summary>A write of a record's Record Flags: the flags the copy held and the flags written.</summary>
internal readonly record struct RecordFlagsWrite(long Held, long Next)
{
    /// <summary>The flags write <paramref name="value"/> makes, or null when it writes another column.</summary>
    internal static RecordFlagsWrite? Of(JsonObject record, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (schema.IsHeader || column.Name != RecordHeaderFlags.Member || value is not { ValueKind: JsonValueKind.Number } requested)
            return null;
        var held = record[RecordHeaderFlags.Member] is JsonValue raw && raw.TryGetValue<long>(out var flags) ? flags : 0;
        return new(held, requested.GetInt64());
    }

    internal bool Sets(long bit) => (Next & bit) != 0 && (Held & bit) == 0;

    internal bool Changes(long bit) => ((Held ^ Next) & bit) != 0;
}
