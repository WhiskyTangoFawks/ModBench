using MEditService.Core.Plugins;

namespace MEditService.Core.Records;

/// <summary>What one plugin's validate found (ADR-0046 invariant 6). <c>NeedsRebuild</c> means the
/// document set or the binary moved, which only a rebuild expresses. <c>Failures</c> tells "nothing
/// drifted" from "nothing was checked" (ADR-0026).</summary>
public sealed record ValidationReport(
    PluginKey Plugin,
    IReadOnlyList<string> ChangedKeys,
    bool NeedsRebuild,
    IReadOnlyList<string> Failures)
{
    internal static ValidationReport Clean(PluginKey plugin) => new(plugin, [], NeedsRebuild: false, []);
}
