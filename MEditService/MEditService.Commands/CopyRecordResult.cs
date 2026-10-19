using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Changes or refusal, per record and destination (ADR-0019). Made in the order answered, the items leave
/// the records copied one after another.</summary>
public sealed record CopyRecordResult(IReadOnlyList<RecordCopied> Applied, IReadOnlyList<CopyRefused> Refused)
    : ISelectionAnswer<CopyRefused>;

/// <summary>The changes copying one record into one destination makes to plugin source, written nowhere, as an
/// edit's are.</summary>
public sealed record RecordCopied(
    RecordAt Record, PluginAddress Destination, IReadOnlyList<SourceMove> Moves,
    IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents);

public sealed record CopyRefused(CopyItem Item, RecordEditRefusal Refusal, string Message) : IItemRefused<RecordEditRefusal>
{
    object IItemRefused<RecordEditRefusal>.Item => Item;
}
