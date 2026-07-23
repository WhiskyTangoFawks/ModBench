using MEditService.Core.Queries;

namespace MEditService.Core.Edits;

public abstract record DeleteRecordsResult
{
    public sealed record NoSession : DeleteRecordsResult;
    public sealed record PluginImmutable(string Plugin) : DeleteRecordsResult;
    public sealed record BlockedByReferences(IReadOnlyList<BlockedReference> BlockedBy) : DeleteRecordsResult;
    // Targets already pending a delete or renumber — re-deleting a record about to cease to exist or
    // change identity is incoherent. Replaces the old "target has any group" block (#134): every
    // change has a group now (ADR-0028), so a record with only pending field edits is deletable.
    public sealed record TargetPendingDeleteOrRenumber(IReadOnlyList<string> FormKeys) : DeleteRecordsResult;
    public sealed record Staged(ChangeGroup Group) : DeleteRecordsResult;

    // A delete target that is itself a pending $create has no on-disk existence for a $delete to act
    // on (#143): deleting it reverts the create's whole dependency component instead (same
    // RevertGroup path the revert-group endpoint uses), never a staged $delete.
    public sealed record Reverted(IReadOnlyList<string> FormKeys) : DeleteRecordsResult;

    // A mixed batch — some targets pending-create, some not — reverts the create targets and stages
    // a delete for the rest. The two outcomes are never collapsed into one undifferentiated result.
    public sealed record Mixed(ChangeGroup StagedGroup, IReadOnlyList<string> RevertedFormKeys) : DeleteRecordsResult;
}
