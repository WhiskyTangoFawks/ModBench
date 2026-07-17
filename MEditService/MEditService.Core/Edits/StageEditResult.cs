namespace MEditService.Core.Edits;

public abstract record StageEditResult
{
    public sealed record Staged(IReadOnlyList<PendingChange> Changes) : StageEditResult;
    public sealed record RecordNotFound() : StageEditResult;
    public sealed record PluginImmutable(string Plugin) : StageEditResult;
    public sealed record ReadOnlyFields(IReadOnlyList<string> Fields) : StageEditResult;
    public sealed record NoSession() : StageEditResult;
    // The subject record is pending a delete or renumber, which makes a field edit on it incoherent:
    // the record is about to cease to exist or change identity. ChangeType is "delete" or "renumber"
    // so the 409 can name the blocking op (ADR-0026). Not "blocked by a group" — every change has a
    // group now (ADR-0028); group membership is not the reason.
    public sealed record RecordPendingDeleteOrRenumber(string ChangeType) : StageEditResult;
    public sealed record InvalidReferences(IReadOnlyList<ReferenceValidationError> Errors) : StageEditResult;
    public sealed record EslIneligible(string Plugin, IReadOnlyList<string> FormKeys) : StageEditResult;
}
