using System.Collections.Concurrent;

namespace MEditService.Core.Ledger;

/// <summary>
/// Per-origin-folder mutex shared by every caller that stages into a ledger repo (#370 review
/// finding 4, promoted out of <c>RecordVendor</c> for #371): git's own <c>index.lock</c> makes two
/// concurrent git-add/commit sequences against the same gitdir race (one throws), and
/// <see cref="LedgerRepository.EnsureRepo"/>'s check-then-create has no lock of its own either. A
/// minimal keyed semaphore closes both — deliberately not a general locking abstraction, just
/// enough to serialize the one shared resource (the gitdir).
///
/// Originally private to <c>RecordVendor</c> (stage-time vendoring); #371 adds a second caller
/// (<c>LedgerGroupCommitter</c>, save-time commit) against the very same gitdir/index, so the gate
/// itself has to be shared too — two independent per-class semaphores would each think they held
/// exclusive access while racing the other.
/// </summary>
internal static class LedgerOriginGate
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates = new(StringComparer.Ordinal);

    internal static SemaphoreSlim GateFor(string originFolder) =>
        Gates.GetOrAdd(Path.GetFullPath(originFolder), static _ => new SemaphoreSlim(1, 1));
}
