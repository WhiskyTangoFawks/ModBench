namespace MEditService.Index;

// ADR-0012 invariant 1.
public record ReferenceRow(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);
