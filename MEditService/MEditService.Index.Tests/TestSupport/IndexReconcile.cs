using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests;

/// <summary>A snapshot built as Mod Management sends one: every plugin, and the active plugins in
/// load order (ADR-0013 invariant 3).</summary>
internal static class IndexReconcile
{
    internal static LoadOrderHolder Reconcile(
        this Indexer index, LoadOrderHolder holder, string gameDirectory,
        IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease, string? instanceRoot = null)
    {
        var snapshot = Snapshot(gameDirectory, instanceRoot, gameRelease, plugins);
        var version = holder.Apply(snapshot);
        index.Reconcile(snapshot, version);
        return holder;
    }

    /// <summary>The snapshot alone, for a caller applying it itself — a subscriber seam test, whose
    /// own subject is what runs off <see cref="LoadOrderHolder.Apply"/>, not this helper.</summary>
    internal static LoadOrderSnapshot Snapshot(
        string gameDirectory, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> plugins) =>
        SnapshotPlugins.Snapshot(gameDirectory, instanceRoot, gameRelease, plugins);
}
