using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>What writing one item of a selection came to.</summary>
internal abstract record ItemAnswer<TRefusal, TOutcome>
{
    internal static ItemAnswer<TRefusal, TOutcome> Landed(TOutcome outcome) => new Wrote(outcome);

    internal static ItemAnswer<TRefusal, TOutcome> Refused(TRefusal refusal, string message) => new Refusing(refusal, message);

    internal sealed record Wrote(TOutcome Outcome) : ItemAnswer<TRefusal, TOutcome>;

    internal sealed record Refusing(TRefusal Refusal, string Message) : ItemAnswer<TRefusal, TOutcome>;
}

/// <summary>A selection, written: each distinct item on its own, with git checked once before the
/// first of them (ADR-0019).</summary>
internal static class ItemWrite
{
    /// <summary>Git missing refuses the whole selection with <paramref name="gitUnavailable"/>, and
    /// nothing is written.</summary>
    internal static async Task<SelectionResult<TItem, TRefusal, TOutcome>> OverAsync<TItem, TRefusal, TOutcome>(
        IEnumerable<TItem> items, IEqualityComparer<TItem> sameItem, TRefusal gitUnavailable,
        Func<TItem, Task<ItemAnswer<TRefusal, TOutcome>>> write)
    {
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return SelectionResult<TItem, TRefusal, TOutcome>.WholeSelectionRefused(gitUnavailable, ex.Message);
        }

        var landed = new List<ItemLanded<TItem, TOutcome>>();
        var refused = new List<ItemRefused<TItem, TRefusal>>();
        foreach (var item in items.Distinct(sameItem))
        {
            switch (await write(item))
            {
                case ItemAnswer<TRefusal, TOutcome>.Wrote wrote:
                    landed.Add(new ItemLanded<TItem, TOutcome>(item, wrote.Outcome));
                    break;
                case ItemAnswer<TRefusal, TOutcome>.Refusing refusing:
                    refused.Add(new ItemRefused<TItem, TRefusal>(item, refusing.Refusal, refusing.Message));
                    break;
            }
        }
        return SelectionResult<TItem, TRefusal, TOutcome>.PerItem(landed, refused);
    }

    /// <summary>A tree another tool changed, or a file system that refused the write, is that item's
    /// answer. <paramref name="failure"/> names what could not be written; the file system's words
    /// follow it.</summary>
    internal static Task<SelectionResult<TItem, RecordEditRefusal, string?>> Over<TItem>(
        IEnumerable<TItem> items, IEqualityComparer<TItem> sameItem,
        Func<TItem, RecordEditResult> write, Func<TItem, string> failure, ILogger logger) =>
        OverAsync(
            items, sameItem, RecordEditRefusal.GitUnavailable,
            item =>
            {
                var result = RefusingTheWriteFailure(() => write(item), failure(item), logger);
                return Task.FromResult(result.Applied
                    ? ItemAnswer<RecordEditRefusal, string?>.Landed(result.NewFormKey)
                    : ItemAnswer<RecordEditRefusal, string?>.Refused(result.Refusal, result.Message));
            });

    /// <summary>A write a single-item gesture makes: the same two refusals <see cref="Over"/> gives an
    /// item.</summary>
    internal static RecordEditResult RefusingTheWriteFailure(Func<RecordEditResult> write, string failure, ILogger logger)
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
