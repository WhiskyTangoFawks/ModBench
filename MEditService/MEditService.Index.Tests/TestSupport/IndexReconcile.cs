using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests;

/// <summary>A snapshot built as Mod Management sends one: every plugin, and the active plugins in
/// load order (ADR-0013).</summary>
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

    /// <summary>The game loads one file per name (ADR-0012), so a read sees the copy of a shared
    /// filename that wins it. Reconciles <paramref name="plugins"/> with <paramref name="origin"/>'s
    /// copies winning, and answers the reads.</summary>
    internal static IRecordReads ReadsWithWinner(
        this Indexer index, LoadOrderHolder holder, string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, string origin)
    {
        index.Reconcile(holder, gameDirectory, Winning(plugins, origin), GameRelease.Fallout4);
        return index.RequireReads();
    }

    internal static IReadOnlyList<LoadOrderEntry> Winning(IReadOnlyList<LoadOrderEntry> plugins, string origin) =>
        [.. plugins.Select(p => plugins.Any(o => o.Origin == origin && o.Name.Equals(p.Name, StringComparison.OrdinalIgnoreCase))
            ? p with { Winning = p.Origin == origin }
            : p)];

    /// <summary>The snapshot alone, for a caller applying it itself — a subscriber seam test, whose
    /// own subject is what runs off <see cref="LoadOrderHolder.Apply"/>, not this helper.</summary>
    internal static LoadOrderSnapshot Snapshot(
        string gameDirectory, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> plugins) =>
        SnapshotPlugins.Snapshot(gameDirectory, instanceRoot, gameRelease, plugins);
}
