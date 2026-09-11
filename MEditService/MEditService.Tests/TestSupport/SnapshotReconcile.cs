using MEditService.Api;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>The snapshot door as the load-order endpoint applies it: the same composition the
/// endpoint calls, reconciled. Tests pass entries, because that is the shape Mod Management
/// sends.</summary>
internal static class SnapshotReconcile
{
    internal static void Reconcile(
        this IndexProjector index, string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins,
        GameRelease gameRelease, string? instanceRoot = null) =>
        index.Reconcile(ForcedPlugins.Snapshot(gameDirectory, instanceRoot, gameRelease, plugins));
}
