namespace MEditService.Core.Records;

public record PlacedSummary(
    string FormKey, string? EditorId, string? BaseFormKey, string RecordType, bool HasParseFailure = false);
