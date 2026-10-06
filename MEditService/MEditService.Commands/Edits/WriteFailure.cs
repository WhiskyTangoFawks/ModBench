using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A write that fails on the disk answers with a refusal, never an exception.</summary>
internal static class WriteFailure
{
    /// <summary>A tree another tool changed, or a file system that refused the write, is the write's
    /// refusal. <paramref name="failure"/> names what could not be written; the file system's words follow it.</summary>
    internal static RecordEditResult Refused(Func<RecordEditResult> write, string failure, ILogger logger) =>
        Refused(write, refused => refused, failure, logger);

    /// <summary><see cref="Refused(Func{RecordEditResult}, string, ILogger)"/> for an answer that carries more
    /// than its outcome; <paramref name="refused"/> makes one of a refusal.</summary>
    internal static T Refused<T>(Func<T> write, Func<RecordEditResult, T> refused, string failure, ILogger logger)
    {
        try
        {
            return write();
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return refused(RecordEditResult.Refused(RecordEditRefusal.AmbiguousSourceUnit, ex.Message));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "{Failure}", failure);
            return refused(RecordEditResult.Refused(RecordEditRefusal.SourceWriteFailed, $"{failure}: {ex.Message}"));
        }
    }
}
