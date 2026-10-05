using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A selection, written: each distinct item on its own, a tree another tool changed or a
/// file system that refused the write being that item's answer (ADR-0019).</summary>
internal static class ItemWrite
{
    /// <summary>Git is checked once, before any item is written. <paramref name="failure"/> says what
    /// could not be written for an item; the file system's words follow it.</summary>
    internal static SelectionResult<TItem> Over<TItem>(
        IEnumerable<TItem> items, IEqualityComparer<TItem> sameItem,
        Func<TItem, RecordEditResult> write, Func<TItem, string> failure, ILogger logger)
    {
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return SelectionResult<TItem>.WholeSelectionRefused(RecordEditRefusal.GitUnavailable, ex.Message);
        }

        var landed = new List<ItemLanded<TItem>>();
        var refused = new List<ItemRefused<TItem>>();
        foreach (var item in items.Distinct(sameItem))
        {
            var result = RefusingTheWriteFailure(() => write(item), failure(item), logger);
            if (result.Applied) landed.Add(new ItemLanded<TItem>(item, result.NewFormKey));
            else refused.Add(new ItemRefused<TItem>(item, result.Refusal, result.Message));
        }
        return SelectionResult<TItem>.PerItem(landed, refused);
    }

    private static RecordEditResult RefusingTheWriteFailure(Func<RecordEditResult> write, string failure, ILogger logger)
    {
        try
        {
            return write();
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return RecordEditResult.Refused(RecordEditRefusal.AmbiguousSourceUnit, ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "{Failure}", failure);
            return RecordEditResult.Refused(RecordEditRefusal.SourceWriteFailed, $"{failure}: {ex.Message}");
        }
    }
}
