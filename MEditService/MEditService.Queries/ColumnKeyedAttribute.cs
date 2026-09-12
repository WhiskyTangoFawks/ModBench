namespace MEditService.Queries;

// Marks a DTO property whose dictionary keys are ColumnKey.Of values; the column-key integrity
// test reflects over this instead of a hand-typed property-name allowlist, which drifts. A
// nested column-keyed dictionary is marked the same way.
[AttributeUsage(AttributeTargets.Property)]
public sealed class ColumnKeyedAttribute : Attribute;
