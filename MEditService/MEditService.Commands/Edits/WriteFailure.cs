using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A write that fails on the disk answers with a refusal, never an exception.</summary>
internal static class WriteFailure
{
    /// <summary>A tree another tool changed, or a file system that refused the write, is the write's
    /// refusal. <paramref name="failure"/> names what could not be written; the file system's words follow it.</summary>
    internal static RecordEditResult Refused(Func<RecordEditResult> write, string failure, ILogger logger)
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
