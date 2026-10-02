namespace MEditService.Index;

/// <summary>What one plugin's validate found (ADR-0015 invariant 4). <c>NeedsRebuild</c>: a new
/// document, named in <c>ChangedKeys</c>, or a moved binary. <c>Failures</c> tells "nothing drifted"
/// from "nothing was checked" (ADR-0019).</summary>
internal sealed record ValidationReport(
    IReadOnlyList<string> ChangedKeys,
    bool NeedsRebuild,
    IReadOnlyList<string> Failures)
{
    internal static readonly ValidationReport Clean = new([], NeedsRebuild: false, []);
}
