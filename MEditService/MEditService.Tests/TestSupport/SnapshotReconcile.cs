using MEditService.Api;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>The snapshot door as the load-order endpoint works it: the value lands in the kernel,
/// then the Index reconciles it. Tests pass entries and take back the holder the queries read.
/// </summary>
internal static class SnapshotReconcile
{
    internal static LoadOrderHolder Reconcile(
        this IndexProjector index, string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins,
        GameRelease gameRelease, string? instanceRoot = null, LoadOrderHolder? holder = null)
    {
        var snapshot = ForcedPlugins.Snapshot(gameDirectory, instanceRoot, gameRelease, plugins);
        holder ??= new LoadOrderHolder();
        holder.Apply(snapshot);
        index.Reconcile(snapshot);
        return holder;
    }
}
