namespace MEditService.Index;

// ADR-0012.
internal sealed record ReferenceRow(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);
