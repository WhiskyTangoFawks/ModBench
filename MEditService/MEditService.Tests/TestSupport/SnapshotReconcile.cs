using MEditService.Api;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>The snapshot door as the load-order endpoint applies it: the endpoint's own deriver
/// composes the copies, and the Index reconciles the value they build. Tests pass entries, because
/// that is the shape Mod Management sends.</summary>
internal static class SnapshotReconcile
{
    internal static void Reconcile(
        this IndexProjector index, string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins,
        GameRelease gameRelease, string? instanceRoot = null) =>
        index.Reconcile(new LoadOrder(
            gameDirectory, instanceRoot, gameRelease,
            ForcedPlugins.Prepend(gameDirectory, gameRelease, plugins)));
}
