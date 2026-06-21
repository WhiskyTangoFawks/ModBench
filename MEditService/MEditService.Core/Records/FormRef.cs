namespace MEditService.Core.Records;

internal record struct FormRef(
    string SourceFormKey,
    string TargetFormKey,
    string FieldPath,
    string RecordType,
    string? EditorId);
