using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>What one plugin's validate found (ADR-0015 invariant 4). <c>NeedsRebuild</c>: a new
/// document, named in <c>ChangedKeys</c>, or a moved binary. <c>Failures</c> tells "nothing drifted"
/// from "nothing was checked" (ADR-0019).</summary>
public sealed record ValidationReport(
    PluginCopyKey Plugin,
    IReadOnlyList<string> ChangedKeys,
    bool NeedsRebuild,
    IReadOnlyList<string> Failures)
{
    internal static ValidationReport Clean(PluginCopyKey plugin) => new(plugin, [], NeedsRebuild: false, []);
}
