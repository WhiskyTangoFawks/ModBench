namespace MEditService.Core.Edits;

public sealed record ReferenceValidationError(
    string FieldPath,
    string Value,
    string Reason, // "null_not_allowed" | "type_mismatch" | "not_in_session"
    IReadOnlyList<string> ExpectedTypes);
