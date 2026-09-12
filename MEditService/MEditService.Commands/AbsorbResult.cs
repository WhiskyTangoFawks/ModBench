using MEditService.SourceRepo;

namespace MEditService.Commands;

/// <summary>Absorb's outcome — the applied-or-refusal spine its Keep sibling returns,
/// so a binary that cannot be parsed is an answer, not an exception. A refused or conflicted
/// <see cref="Rebase"/> still leaves Absorb applied.</summary>
public sealed record AbsorbResult(bool Applied, string? RefusalReason, RebaseResult? Rebase = null)
{
    public static AbsorbResult Success(RebaseResult? rebase = null) => new(true, null, rebase);

    public static AbsorbResult Refused(string reason) => new(false, reason);
}
