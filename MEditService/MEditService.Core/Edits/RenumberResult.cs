using MEditService.Core.Queries;

namespace MEditService.Core.Edits;

public abstract record RenumberResult
{
    public sealed record NoSession : RenumberResult;
    public sealed record PluginImmutable(string Plugin) : RenumberResult;
    public sealed record RecordNotFound : RenumberResult;
    // The target is already pending a delete or renumber, which makes issuing a new renumber
    // incoherent: it's either about to cease to exist, or its identity is already in flux from an
    // earlier renumber. ChangeType is "delete" or "renumber" so the 409 can name the blocking op
    // (ADR-0026). Not "blocked by a group" — every change has a group now (ADR-0028); group
    // membership is not the reason. #391: the mirror of DeleteRecordsResult.
    // TargetPendingDeleteOrRenumber's own guard, closing the asymmetry where only DeleteRecords()
    // refused the other direction.
    public sealed record RecordPendingDeleteOrRenumber(string ChangeType) : RenumberResult;
    public sealed record ImmutableReferences(IReadOnlyList<ReferenceResult> Blockers) : RenumberResult;
    public sealed record FormIdInUse : RenumberResult;
    public sealed record EslIneligible(string Plugin, IReadOnlyList<string> FormKeys) : RenumberResult;
    public sealed record Staged(ChangeGroup Group) : RenumberResult;
}
