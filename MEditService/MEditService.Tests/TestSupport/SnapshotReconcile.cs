using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>The snapshot door as the load-order endpoint applies it: entries become the load order
/// value, and the Index reconciles that. Tests build entries, not values, because that is the shape
/// Mod Management sends.</summary>
internal static class SnapshotReconcile
{
    internal static void Reconcile(
        this IndexProjector index, string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins,
        GameRelease gameRelease, string? instanceRoot = null) =>
        index.Reconcile(LoadOrder.From(gameDirectory, instanceRoot, gameRelease, plugins));
}
