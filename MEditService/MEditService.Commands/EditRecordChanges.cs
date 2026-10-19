using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The changes an edit makes to plugin source, written nowhere: each move, then each deletion, then each
/// document's new text at its absolute path once moved. FormKey and Path are the request's.</summary>
public sealed record EditRecordChanges(
    string FormKey, string Path, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents,
    string? NewFormKey = null);
