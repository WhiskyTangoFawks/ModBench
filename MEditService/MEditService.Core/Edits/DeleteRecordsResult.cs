using MEditService.Core.Queries;

namespace MEditService.Core.Edits;

public abstract record DeleteRecordsResult
{
    public sealed record NoSession : DeleteRecordsResult;
    public sealed record PluginImmutable(string Plugin) : DeleteRecordsResult;
    public sealed record BlockedByReferences(IReadOnlyList<BlockedReference> BlockedBy) : DeleteRecordsResult;
    public sealed record BlockedByPendingGroup(IReadOnlyList<string> FormKeys) : DeleteRecordsResult;
    public sealed record Staged(ChangeGroup Group) : DeleteRecordsResult;
}
