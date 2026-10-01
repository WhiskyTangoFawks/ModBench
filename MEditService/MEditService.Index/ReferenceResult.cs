namespace MEditService.Index;

// ADR-0012 invariant 1: a plugin is (origin, filename) on every payload.
public record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);
