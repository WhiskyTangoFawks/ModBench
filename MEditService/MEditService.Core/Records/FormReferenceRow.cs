namespace MEditService.Core.Records;

internal record struct FormReferenceRow(
    string SourceFormKey,
    string TargetFormKey,
    string FieldPath,
    string RecordType,
    string? EditorId);
