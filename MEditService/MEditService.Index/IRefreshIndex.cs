using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>ADR-0015 invariants 2 and 4: the Index as the watcher sees it. It answers nothing about
/// the load order, which the watcher reads from the kernel's holder (ADR-0013 invariant 4).</summary>
public interface IRefreshIndex
{
    /// <summary>One settled batch is one logical write across several of the doors below, so the
    /// watcher holds this for the batch rather than per plugin.</summary>
    IndexWriteGate WriteGate { get; }

    /// <summary>True once the store is closed: a batch that settles after that has nowhere to
    /// land.</summary>
    bool Closed { get; }

    /// <summary>Everything projected inside the scope advances the Index's sequence once.</summary>
    IDisposable BeginProjection();

    /// <summary>ADR-0013 invariant 1's one verb: registrations made equal to the snapshot, never-held
    /// plugins indexed, one winner sweep. Runs on the caller's thread and never throws.</summary>
    void Reconcile(LoadOrderSnapshot snapshot, long version);

    /// <summary>The narrow signal: re-project exactly these keys from the source tree.</summary>
    void RefreshKeys(PluginAddress key, IReadOnlyList<string> formKeys);

    /// <summary>The wide signal: compare by content hash and repair what differs. <c>NeedsRebuild</c>
    /// names a plugin this call re-derived whole.</summary>
    IReadOnlyList<ValidationReport> ValidateIndex(PluginAddress? plugin);

    /// <summary>ADR-0009: a binary watch's own settle, key and path only — the Index owns the
    /// comparison, indexed already or not yet (ADR-0003), or gone from disk. False for the one
    /// case nothing landed: identical bytes.</summary>
    Task<bool> RefreshBinary(PluginAddress key, string path);
}
