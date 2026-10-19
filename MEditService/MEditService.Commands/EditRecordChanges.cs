using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The changes an edit makes to plugin source, written nowhere: each move, then each deletion, then each
/// document's new text at its absolute path once moved. FormKey and Path are the request's.</summary>
public sealed record EditRecordChanges(
    string FormKey, string Path, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents,
    string? NewFormKey = null);

/// <summary>The changes creating a record makes to plugin source, written nowhere, as an edit's are.</summary>
public sealed record CreateRecordChanges(
    string FormKey, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents);
