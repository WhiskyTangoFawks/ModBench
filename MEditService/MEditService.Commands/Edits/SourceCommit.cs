using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A gesture writing several documents through one <see cref="SourceTransaction"/>:
/// all land, or the tree is put back and the failure names what it left standing.</summary>
internal static class SourceCommit
{
    /// <summary>Applies <paramref name="plan"/>'s changes and answers its outcome, or the refusal of a write that
    /// failed, with the tree put back.</summary>
    internal static RecordEditResult Apply(EditPlan plan, ILogger logger)
    {
        if (plan.Repository is not { } repository) return plan.Outcome;
        var transaction = new SourceTransaction();
        return Run(transaction, repository, logger, plan.Failed, () =>
        {
            transaction.Apply(repository, plan.Changes);
            return plan.Outcome;
        }, refused => refused);
    }

    /// <summary>Runs <paramref name="plan"/>, which writes nothing, and answers its refusal in the words a failed
    /// write of it would use.</summary>
    internal static EditPlan Plan(SourceRepository repository, ILogger logger, string failed, Func<EditPlan> plan) =>
        Run<EditPlan>(new SourceTransaction(), repository, logger, failed, plan, refused => refused);

    // A tree not as the gesture needs it is a refusal (ADR-0014), and so is a filesystem fault; anything
    // else is a bug.
    private static T Run<T>(
        SourceTransaction transaction, SourceRepository repository, ILogger logger, string failed, Func<T> write,
        Func<RecordEditResult, T> refused)
    {
        try
        {
            return write();
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return refused(RecordEditResult.Refused(
                ex is AmbiguousSourceUnitException ? RecordEditRefusal.AmbiguousSourceUnit : RecordEditRefusal.SourceUnitNotFound,
                RollBack(transaction, repository, logger, failed, ex)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "{Failed}", failed);
            return refused(RecordEditResult.Refused(RecordEditRefusal.SourceWriteFailed, RollBack(transaction, repository, logger, failed, ex)));
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
        SourceTransaction transaction, SourceRepository repository, ILogger logger, string failed, Exception cause)
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
