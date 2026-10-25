using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests;

/// <summary>A load order reaching a subscribed Index the way the put-load-order handler sends one
/// (ADR-0013): the snapshot lands on the holder, and the test waits for the status that answers its
/// version.</summary>
internal static class LoadOrderArrival
{
    internal static LoadOrderHolder Reconcile(
        this OpenedIndex index, LoadOrderHolder holder, string dataFolder,
        IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease, string? instanceRoot = null)
    {
        index.Receive(holder, SnapshotPlugins.Snapshot(dataFolder, instanceRoot, gameRelease, plugins));
        return holder;
    }

    /// <summary>The version the snapshot arrived as, once the Index's status answers it.</summary>
    internal static long Receive(this OpenedIndex index, LoadOrderHolder holder, LoadOrderSnapshot snapshot)
    {
        var answered = index.Status.Version;
        var version = holder.Apply(snapshot);
        if (version <= answered)
            throw new InvalidOperationException("An equal snapshot has no version to wait for: wait on what it announces.");
        index.AwaitVersion(version);
        return version;
    }

    internal static void AwaitVersion(this OpenedIndex index, long version) =>
        Waits.Reached(() => index.Status.Version >= version, $"the status answering version {version}");
}
