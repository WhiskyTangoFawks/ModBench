using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests;

/// <summary>The snapshot door as the put-load-order handler works it, with nothing forced: the value
/// lands in the kernel, then the Index reconciles it off the same holder.</summary>
internal static class SnapshotReconcile
{
    internal static LoadOrderHolder Reconcile(
        this Indexer index, LoadOrderHolder holder, string gameDirectory,
        IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease, string? instanceRoot = null)
    {
        var snapshot = new LoadOrderSnapshot(gameDirectory, instanceRoot, gameRelease, SnapshotPlugins.Of(plugins));
        var version = holder.Apply(snapshot);
        index.Reconcile(snapshot, version);
        return holder;
    }
}
