using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A tree not as a write needs it (ADR-0014), or a file system or git that refused to read or write
/// it, is the write's refusal.</summary>
internal static class WriteFailure
{
    /// <summary>The refusal <paramref name="failure"/> comes to. <paramref name="what"/> names what could not
    /// be read or written; the failure's words follow it.</summary>
    internal static RecordEditResult Refusal(SourceFailure failure, string what, ILogger logger)
    {
        var refusal = KindOf(failure);
        if (refusal == RecordEditRefusal.SourceAccessFailed)
            logger.LogError((failure as SourceFailure.Inaccessible)?.Error, "{Failure}: {Reason}", what, failure.Reason);
        return refusal is RecordEditRefusal.RecordParseFailed or RecordEditRefusal.SourceAccessFailed
            ? RecordEditResult.Refused(refusal, $"{what}: {failure.Reason}")
            : RecordEditResult.Refused(refusal, failure.Reason);
    }

    /// <summary>The refusal whose way out is the way out of <paramref name="failure"/>.</summary>
    internal static RecordEditRefusal KindOf(SourceFailure failure) => failure switch
    {
        SourceFailure.Ambiguous or SourceFailure.TwinFolders => RecordEditRefusal.AmbiguousSourceUnit,
        SourceFailure.NotCarried => RecordEditRefusal.SourceUnitNotFound,
        SourceFailure.SlotHeld => RecordEditRefusal.ChildSlotHeldByAnotherRecord,
        SourceFailure.Unreadable => RecordEditRefusal.RecordParseFailed,
        SourceFailure.GitUnavailable => RecordEditRefusal.GitUnavailable,
        SourceFailure.Inaccessible or SourceFailure.GitFailed => RecordEditRefusal.SourceAccessFailed,
        _ => throw new InvalidOperationException($"Expected one of the failures the Source adapter answers, not {failure.GetType().Name}."),
    };

    /// <summary><paramref name="answer"/>'s value, or the refusal its failure comes to as
    /// <see cref="Refusal"/> says; <paramref name="refused"/> makes one of a refusal.</summary>
    internal static T Refused<T>(SourceAnswer<T> answer, Func<RecordEditResult, T> refused, string what, ILogger logger) =>
        answer.Holds(out var value, out var failure) ? value : refused(Refusal(failure, what, logger));
}
