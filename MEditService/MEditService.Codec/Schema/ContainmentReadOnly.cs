namespace MEditService.Codec.Schema;

/// <summary>The members a <see cref="ContainmentMember"/> row names: a field edit cannot move a record, so
/// each is read-only, with why.</summary>
internal static class ContainmentReadOnly
{
    internal static ColumnSpec Marked(ColumnSpec column, IReadOnlyList<Type> recordGetters, SchemaAnnotations annotations) =>
        annotations.ContainmentReasonFor(recordGetters, column.PropertyName) is { } reason
            ? column with { Field = column.Field.WithReadOnlyReason(reason) }
            : column;
}
