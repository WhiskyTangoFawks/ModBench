using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Changes or refusal, per record and destination (ADR-0019). Made in the order answered, the items leave
/// the records copied one after another.</summary>
public sealed record CopyRecordResult(IReadOnlyList<RecordCopied> Applied, IReadOnlyList<CopyRecordRefused> Refused)
    : ISelectionAnswer<CopyRecordRefused>;

/// <summary>The changes copying one record into one destination makes to plugin source, written nowhere, as an
/// edit's are. NewFormKey is the FormKey a copy as new drew, null for an override.</summary>
public sealed record RecordCopied(
    RecordAt Record, PluginAddress Destination, IReadOnlyList<SourceMove> Moves,
    IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents,
    string? NewFormKey = null);

/// <summary>A record and destination of the selection that wrote nothing: the typed refusal, and the message naming
/// the way out.</summary>
public sealed record CopyRecordRefused(CopyItem Item, RecordEditRefusal Refusal, string Message) : IItemRefused<RecordEditRefusal>
{
    object IItemRefused<RecordEditRefusal>.Item => Item;
}
