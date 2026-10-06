using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A tree not as an edit's plan needs it is the edit's refusal (ADR-0014), and so is a filesystem
/// fault; anything else is a bug.</summary>
internal static class PlanFailure
{
    /// <summary>Runs <paramref name="plan"/>, or refuses with <paramref name="failed"/> and the cause's words.</summary>
    internal static RecordEditChanges Refused(ILogger logger, string failed, Func<RecordEditChanges> plan)
    {
        try
        {
            return plan();
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return RecordEditResult.Refused(
                ex is AmbiguousSourceUnitException ? RecordEditRefusal.AmbiguousSourceUnit : RecordEditRefusal.SourceUnitNotFound,
                $"{failed} {ex.Message}");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "{Failed}", failed);
            return RecordEditResult.Refused(RecordEditRefusal.SourceWriteFailed, $"{failed} {ex.Message}");
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogError(ex, "{Failed}", failed);
            throw;
        }
    }
}
