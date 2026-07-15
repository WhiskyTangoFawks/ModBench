namespace MEditService.Core.Edits;

public abstract record CreateRecordOutcome
{
    public sealed record Success(string FormKey, System.Guid GroupId) : CreateRecordOutcome;
    public sealed record InvalidReferences(System.Collections.Generic.IReadOnlyList<ReferenceValidationError> Errors) : CreateRecordOutcome;
    public sealed record EslIneligible(string Plugin, System.Collections.Generic.IReadOnlyList<string> FormKeys) : CreateRecordOutcome;
}
