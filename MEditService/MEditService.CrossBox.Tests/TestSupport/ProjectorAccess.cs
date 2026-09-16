using MEditService.Index;
using MEditService.LoadOrder;

namespace MEditService.Tests.TestSupport;

/// <summary>ADR-0014: no interface carries the projector's landing verb, so a test standing in for
/// the Source watcher's refresh reaches the one implementation directly rather than casting at every
/// call site.</summary>
internal static class ProjectorAccess
{
    internal static void ProjectDocuments(
        this IRecordIndex index, PluginCopyKey key, IReadOnlyList<(string FormKey, string? Body)> deltas) =>
        ((DuckDbRecordIndex)index).ProjectDocuments(key, deltas);
}
