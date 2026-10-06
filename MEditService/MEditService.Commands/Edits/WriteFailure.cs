using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A tree not as a write needs it (ADR-0014), or a file system that refused to read or write it, is the
/// write's refusal. Any other throw is an invariant violation, and stays one.</summary>
internal static class WriteFailure
{
    /// <summary><paramref name="failure"/> names what could not be read or written; the cause's words follow it.</summary>
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
        catch (SourceUnitNotFoundException ex)
        {
            return refused(RecordEditResult.Refused(RecordEditRefusal.SourceUnitNotFound, ex.Message));
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return refused(RecordEditResult.Refused(RecordEditRefusal.RecordParseFailed, $"{failure}: {ex.Message}"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "{Failure}", failure);
            return refused(RecordEditResult.Refused(RecordEditRefusal.SourceAccessFailed, $"{failure}: {ex.Message}"));
        }
    }
}
