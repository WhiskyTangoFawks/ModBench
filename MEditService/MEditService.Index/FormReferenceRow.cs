namespace MEditService.Index;

internal record struct FormReferenceRow(
    string SourceFormKey,
    string TargetFormKey,
    string FieldPath,
    string RecordType,
    string? EditorId);
