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
}
