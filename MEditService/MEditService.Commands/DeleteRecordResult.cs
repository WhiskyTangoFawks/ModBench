using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Changes or refusal, per record (ADR-0019): a refusal is an item of the answer, never the status of the call.
/// Made in the order answered, the items leave the records deleted one after another.</summary>
public sealed record DeleteRecordResult(IReadOnlyList<RecordDeleted> Applied, IReadOnlyList<DeleteRefused> Refused)
    : ISelectionAnswer<DeleteRefused>;

/// <summary>The changes deleting one record makes to plugin source, written nowhere, as an edit's are.</summary>
public sealed record RecordDeleted(
    RecordAt Record, IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents);

/// <summary>A record of the selection that wrote nothing: the typed refusal, and the message naming the way out.</summary>
public sealed record DeleteRefused(RecordAt Item, RecordEditRefusal Refusal, string Message) : IItemRefused<RecordEditRefusal>
{
    object IItemRefused<RecordEditRefusal>.Item => Item;
}
