using MEditService.Core.Notifications;
using MEditService.Core.Plugins;

namespace MEditService.Core.Records;

/// <summary>ADR-0015 invariants 2 and 4: the Index as the watcher sees it. It answers nothing about
/// the load order, which the watcher reads from the kernel's holder (ADR-0013 invariant 4).</summary>
public interface IRefreshIndex
{
    /// <summary>One settled batch is one logical write across several of the doors below, so the
    /// watcher holds this for the batch rather than per plugin.</summary>
    IndexWriteGate WriteGate { get; }

    /// <summary>None once the store is closed: a batch that settles after that has nowhere to
    /// land.</summary>
    LoadOrderStatus Status { get; }

    long Sequence { get; }

    /// <summary>Everything projected inside the scope advances <see cref="Sequence"/> once.</summary>
    IDisposable BeginProjection();

    /// <summary>Runs <paramref name="publish"/> once the projection it was raised in has landed, so
    /// nothing names a sequence the store has not reached.</summary>
    void Announce(Action publish);

    /// <summary>The narrow signal: re-project exactly these keys from the source tree.</summary>
    void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys);

    /// <summary>The wide signal: compare by content hash and repair what differs. <c>NeedsRebuild</c>
    /// names a copy this call re-derived whole.</summary>
    IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin);

    Task ReindexPlugin(PluginKey key);

    void UnindexPlugin(PluginKey key);

    /// <summary>ADR-0009: the hash the store's rows for this copy were built from, or null when it
    /// holds no validated rows for it — the indexed-binary watch's baseline.</summary>
    string? IndexedContentHash(PluginKey key);
}
