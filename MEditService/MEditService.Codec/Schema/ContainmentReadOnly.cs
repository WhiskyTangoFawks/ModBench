using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>A record's members its containment owns: a container's child slots, and the members a
/// <see cref="ContainmentMember"/> row names. A field edit cannot add, remove or move a record, so
/// each is read-only, with why.</summary>
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
        $"it holds {tableName}'s child records, each a record of its own, kept in this document in Mutagen's list " +
        "order (ADR-0020). A child record is added or removed by its own gestures (create, delete, copy), not by " +
        "editing the slot";
}
