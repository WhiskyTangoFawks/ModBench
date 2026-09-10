namespace MEditService.Core.Source;

/// <summary>Keep's outcome — a typed refusal (naming the colliding records), never a
/// partial apply: either every touched record lands, or none of them do.</summary>
public sealed record ExternalChangeLandResult(bool Applied, string? RefusalReason, IReadOnlyList<string> LandedFormKeys)
{
    public static ExternalChangeLandResult Success(IReadOnlyList<string> landedFormKeys) => new(true, null, landedFormKeys);

    public static ExternalChangeLandResult Refused(string reason) => new(false, reason, []);
}
