using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A gesture writing several documents through one <see cref="SourceRepository.SourceTransaction"/>:
/// all land, or the tree is put back and the failure names what it left standing.</summary>
internal static class SourceCommit
{
    /// <summary>Runs <paramref name="write"/> and answers its refusal, or null once it lands. A tree not as
    /// the gesture needs it is a refusal (ADR-0014 invariant 4), a filesystem fault a write failure, anything
    /// else a bug.</summary>
    internal static RecordEditResult? Write(
        SourceRepository.SourceTransaction transaction, SourceRepository repository, ILogger logger, string failed,
        Func<RecordEditResult?> write)
    {
        try
        {
            return write();
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return RecordEditResult.Refused(
                ex is AmbiguousSourceUnitException ? RecordEditRefusal.AmbiguousSourceUnit : RecordEditRefusal.SourceUnitNotFound,
                RollBack(transaction, repository, logger, failed, ex));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new IOException(RollBack(transaction, repository, logger, failed, ex), ex);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogError(ex, "{Report}", RollBack(transaction, repository, logger, failed, ex));
            throw;
        }
    }

    // Only the tree is put back; the next snapshot lands the restored files. Paths are relative to
    // the mod folder, the form the Source Control panel lists.
    private static string RollBack(
        SourceRepository.SourceTransaction transaction, SourceRepository repository, ILogger logger, string failed, Exception cause)
    {
        var (unrestored, relativeError) = transaction.Rollback(cause, repository);
        if (unrestored.Count > 0)
        {
            logger.LogWarning(
                "Rolling back after \"{Failed}\" left {Count} path(s) as they stood: {Paths}",
                failed, unrestored.Count,
                string.Join("; ", unrestored.Select(u => $"{u.FullPath} [{u.Reason}{(u.Error is null ? "" : $": {u.Error}")}]")));
        }

        var sentences = new List<string>
        {
            failed,
            unrestored.Count == 0
                ? "Every source tree it had written is back as it was — nothing to review or revert."
                : "Every source tree it had written is back as it was, except:",
        };

        sentences.AddRange(new[]
        {
            (UnrestoredReason.ChangedByAnother,
                "changed by something else after this change wrote them, so their current content was kept"),
            (UnrestoredReason.RemovedByAnother,
                "removed by something else after this change wrote them, so they were not put back"),
            (UnrestoredReason.OccupiedByAnother,
                "occupied by something else, so what this change moved away was not moved back"),
            (UnrestoredReason.RestoreFailed, "could not be restored"),
        }.Select(r => NamedPaths(unrestored, r.Item1, r.Item2)).OfType<string>());

        sentences.Add($"Underlying error: {relativeError}");
        return string.Join(" ", sentences);
    }

    private static string? NamedPaths(
        IReadOnlyList<UnrestoredPath> unrestored, UnrestoredReason reason, string phrase)
    {
        var named = unrestored.Where(u => u.Reason == reason).Select(u => u.RelativePath).ToList();
        return named.Count == 0 ? null : $"{string.Join(", ", named)} — {phrase}.";
    }
}
