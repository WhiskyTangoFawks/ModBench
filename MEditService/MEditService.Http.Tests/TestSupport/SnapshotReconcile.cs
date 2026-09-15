using MEditService.Http;
using MEditService.Index;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>The snapshot door as the load-order endpoint works it: the value lands in the kernel,
/// then the Index reconciles it. The holder is the one the Index was built with, so both sides read
/// one value.</summary>
internal static class SnapshotReconcile
{
    internal static LoadOrderHolder Reconcile(
        this IndexProjector index, LoadOrderHolder holder, string gameDirectory,
        IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease, string? instanceRoot = null)
    {
        var snapshot = ForcedPlugins.Snapshot(gameDirectory, instanceRoot, gameRelease, plugins);
        holder.Apply(snapshot);
        index.Reconcile(snapshot);
        return holder;
    }
}
