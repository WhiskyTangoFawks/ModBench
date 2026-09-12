namespace MEditService.Core.Records;

// Origin (ADR-0012): additive alongside Plugin; without it two same-filename sources referencing
// the same target are indistinguishable.
public record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);
