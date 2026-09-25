namespace MEditService.Commands;

/// <summary>Absorb's outcome — the applied-or-refusal spine its Keep sibling returns,
/// so a binary that cannot be parsed is an answer, not an exception.</summary>
public sealed record AbsorbResult(bool Applied, string? RefusalReason)
{
    public static AbsorbResult Success() => new(true, null);

    public static AbsorbResult Refused(string reason) => new(false, reason);
}
