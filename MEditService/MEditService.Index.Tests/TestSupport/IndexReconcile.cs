using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests;

/// <summary>A shared filename's winning copy, as the game loads it (ADR-0012).</summary>
internal static class IndexReconcile
{
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
}
