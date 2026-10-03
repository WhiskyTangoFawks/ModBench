using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>One item of a selection, written: a tree another tool changed, or a file system that
/// refused the write, is that item's answer, not the batch's (ADR-0019).</summary>
internal static class ItemWrite
{
    /// <summary><paramref name="failure"/> says what could not be written; the file system's words
    /// follow it.</summary>
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
