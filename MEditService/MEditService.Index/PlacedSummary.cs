namespace MEditService.Index;

public record PlacedSummary(
    string FormKey, string? EditorId, string? BaseFormKey, string RecordType, bool HasParseFailure = false,
    string? FullName = null, string? BaseEditorId = null, string? ParseDiagnosis = null);
