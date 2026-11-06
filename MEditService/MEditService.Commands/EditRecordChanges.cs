using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The changes an edit makes to plugin source, written nowhere: each move, then each deletion, then each
/// document's new text at its absolute path once moved. Plugins: each plugin whose source they change.</summary>
public sealed record EditRecordChanges(
    string FormKey, string Path, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents,
    string? NewFormKey, IReadOnlyList<PluginAddress> Plugins, IReadOnlyList<SourceLeftBehind> LeftBehind, IReadOnlyList<RecordAt> CopiesLeftBehind);

/// <summary>A script's edit, written: the new FormKey of a FormKey change, and each plugin source and copy it left
/// naming the old one.</summary>
public sealed record RecordEdited(string? NewFormKey, IReadOnlyList<SourceLeftBehind> LeftBehind, IReadOnlyList<RecordAt> CopiesLeftBehind);

/// <summary>An edit made in its sessions, each plugin whose source it changes, and what it left behind.</summary>
internal sealed record EditedRecord(
    RecordEditResult Outcome, IReadOnlyList<PluginAddress> Plugins, IReadOnlyList<SourceLeftBehind> LeftBehind, IReadOnlyList<RecordAt> CopiesLeftBehind);
