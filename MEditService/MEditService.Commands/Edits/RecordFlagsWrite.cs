using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

namespace MEditService.Commands.Edits;

/// <summary>A write of a record's Record Flags: the flags the copy held and the flags written.</summary>
internal readonly record struct RecordFlagsWrite(long Held, long Next)
{
    /// <summary>The flags <paramref name="value"/> writes to <paramref name="column"/>, or null when it writes
    /// another column.</summary>
    internal static long? Requested(RecordTableSchema schema, ColumnSpec column, EditValue? value) =>
        schema.IsHeader || column.Name != RecordHeaderFlags.Member || value is not { Kind: EditValueKind.WholeNumber } requested
            ? null
            : requested.Integer;

    internal static RecordFlagsWrite? Of(Document record, long? requested) =>
        requested is { } next ? new(HeldBy(record), next) : null;

    internal static long HeldBy(Document record) => record.IntegerAt(RecordHeaderFlags.Member) ?? 0;

    internal bool Sets(long bit) => (Next & bit) != 0 && (Held & bit) == 0;

    internal bool Changes(long bit) => ((Held ^ Next) & bit) != 0;
}
