namespace MEditService.Core.Edits;

public abstract record CreateRecordOutcome
{
    public sealed record Success(string FormKey, System.Guid GroupId) : CreateRecordOutcome;
    public sealed record InvalidReferences(System.Collections.Generic.IReadOnlyList<ReferenceValidationError> Errors) : CreateRecordOutcome;
}
