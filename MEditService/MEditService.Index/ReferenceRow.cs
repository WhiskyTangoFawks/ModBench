namespace MEditService.Index;

// ADR-0012.
public record ReferenceRow(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);
