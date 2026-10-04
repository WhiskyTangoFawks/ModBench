using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests;

/// <summary>A load order reaching a subscribed Index the way the put-load-order handler sends one
/// (ADR-0013): the snapshot lands on the holder, and the test waits for the status that answers its
/// version.</summary>
internal static class LoadOrderArrival
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    internal static LoadOrderHolder Reconcile(
        this Indexer index, LoadOrderHolder holder, string gameDirectory,
        IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease, string? instanceRoot = null)
    {
        index.Receive(holder, Snapshot(gameDirectory, instanceRoot, gameRelease, plugins));
        return holder;
    }

    /// <summary>The version the snapshot arrived as, once the Index's status answers it.</summary>
    internal static long Receive(this Indexer index, LoadOrderHolder holder, LoadOrderSnapshot snapshot)
    {
        var answered = index.Status.Version;
        var version = holder.Apply(snapshot);
        if (version <= answered)
            throw new InvalidOperationException("An equal snapshot has no version to wait for: wait on what it announces.");
        index.AwaitVersion(version);
        return version;
    }

    internal static LoadOrderSnapshot Snapshot(
        string gameDirectory, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> plugins) =>
        SnapshotPlugins.Snapshot(gameDirectory, instanceRoot, gameRelease, plugins);

    internal static void AwaitVersion(this Indexer index, long version) =>
        Waits.Reached(() => index.Status.Version >= version, $"the status answering version {version}", Patience);
}
