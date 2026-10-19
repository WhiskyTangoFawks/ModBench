using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The changes creating a record makes to plugin source, written nowhere, as an edit's are.</summary>
public sealed record CreateRecordChanges(
    string FormKey, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents);
