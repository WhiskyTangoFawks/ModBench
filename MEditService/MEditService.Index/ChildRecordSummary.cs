namespace MEditService.Index;

public record ChildRecordSummary(
    string FormKey, string? EditorId, string? BaseFormKey, string RecordType, WorkingTreeState WorkingTreeState,
    bool HasParseFailure = false, string? FullName = null, string? BaseEditorId = null, string? ParseDiagnosis = null);
