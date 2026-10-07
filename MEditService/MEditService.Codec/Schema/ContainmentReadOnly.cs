using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>A record's members its containment owns: a write to one moves records in the source tree,
/// which is a structural gesture, so the column is read-only, with why (ADR-0006).</summary>
internal static class ContainmentReadOnly
{
    internal static ColumnSpec Marked(
        ColumnSpec column, string tableName, IReadOnlyList<Type> recordGetters, SchemaAnnotations annotations) =>
        ReasonFor(column.PropertyName, tableName, recordGetters, annotations) is { } reason
            ? column with { Field = column.Field with { ReadOnlyReason = reason } }
            : column;

    private static string? ReasonFor(
        string member, string tableName, IReadOnlyList<Type> recordGetters, SchemaAnnotations annotations) =>
        recordGetters.Any(getter => ContainerChildFields.EnumerateChildFieldsFor(getter)?.Contains(member, StringComparer.Ordinal) == true)
            ? ChildSlotReason(tableName)
            : annotations.ContainmentReasonFor(recordGetters, member);

    private static string ChildSlotReason(string tableName) =>
        $"it holds {tableName}'s child records, and containment is expressed by the source tree's own structure " +
        "rather than by a field (ADR-0006). Adding, removing or reordering a container's children is a structural " +
        "gesture, not a field edit";
}
