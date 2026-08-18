using MEditService.Core.Session;

namespace MEditService.Core.Ledger;

/// <summary>Which kind of working-tree change a record's ledger entry carries, read honestly off
/// git's own porcelain status code rather than assumed — today's write paths
/// (<see cref="RecordVendor"/>/<see cref="LedgerGroupCommitter"/>) always commit a record's
/// baseline before any dirt is ever written, so <see cref="Modified"/> is the only value the
/// current backend can ever actually produce; the others exist so a future write path (or an
/// external tool editing ledger text directly) is reported for what it is instead of silently
/// mislabeled as a modification.</summary>
public enum LedgerChangeKind
{
    Modified,
    Added,
    Deleted,
    Renamed,
    Unknown,
}

/// <summary>One changed record on the working-tree group of the aggregate SCM provider (#368):
/// enough identity to label and group it (<see cref="Plugin"/>/<see cref="Origin"/>/
/// <see cref="RecordType"/>/<see cref="FormKey"/>), an absolute path to its real working-tree file
/// (<see cref="RecordPath"/> — the frontend opens this directly as the diff's "dirty" side, no
/// further backend round-trip needed), and its committed text (<see cref="CommittedText"/> — the
/// diff's "committed" side, which exists only in git history and so has no file of its own to
/// point at).</summary>
public sealed record LedgerStatusEntry(
    string Plugin,
    string Origin,
    string RecordType,
    string FormKey,
    LedgerChangeKind ChangeKind,
    string RecordPath,
    string CommittedText);

/// <summary>Reads the ledger's real working-tree state across every tracked plugin in the current
/// session (#368) — the backend half of the aggregate SCM provider. Answers purely by asking git
/// (<see cref="LedgerRepository.WorkingTreeStatus"/>) and reading a path's own text
/// (<see cref="LedgerRecordPath.TryParse"/>, <see cref="LedgerRepository.ReadTextAtCommit"/>);
/// nothing here re-derives what <see cref="RecordVendor"/>/<see cref="LedgerGroupCommitter"/>
/// already committed.</summary>
public sealed class LedgerStatusQuery(LedgerRepository ledger)
{
    public IReadOnlyList<LedgerStatusEntry> GetWorkingTreeChanges(IGameSession? session)
    {
        if (session == null) return [];

        var entries = new List<LedgerStatusEntry>();

        // Grouped by physical origin folder, same resolution EditOrchestrator.VendorOnFirstTouch
        // and PluginSaver.CollectTouchedRecords already use — an origin folder providing more than
        // one plugin file shares one ledger repo (LedgerGroupCommitter's own class remarks), so one
        // status read covers every plugin from that origin at once.
        var byOriginFolder = session.Plugins
            .Where(p => p.InLoadOrder)
            .Select(p => (Plugin: p, OriginFolder: Path.GetDirectoryName(p.Path)))
            .Where(x => !string.IsNullOrEmpty(x.OriginFolder))
            .GroupBy(x => x.OriginFolder!, StringComparer.Ordinal);

        foreach (var group in byOriginFolder)
        {
            var originFolder = group.Key;
            if (!ledger.RepoExists(originFolder)) continue;

            var pluginsByFileName = group
                .Select(x => x.Plugin)
                .ToDictionary(p => p.Name, p => p, StringComparer.OrdinalIgnoreCase);

            foreach (var (statusCode, relativePath) in ledger.WorkingTreeStatus(originFolder))
            {
                if (!LedgerRecordPath.TryParse(relativePath, out var identity)) continue;
                if (!pluginsByFileName.TryGetValue(identity.PluginFileName, out var plugin)) continue;

                // A record whose ledger path parses but was never committed (not reachable through
                // today's write paths — see LedgerChangeKind's own remarks — but this listing must
                // not assert a HEAD reading that doesn't exist) has nothing to read a committed side
                // from; skipped rather than reported with a fabricated "committed" text.
                if (!ledger.IsTrackedAtHead(originFolder, relativePath)) continue;

                var committedText = ledger.ReadTextAtCommit(originFolder, relativePath, "HEAD");
                entries.Add(new LedgerStatusEntry(
                    plugin.Name,
                    plugin.Origin,
                    identity.RecordType,
                    identity.FormKey,
                    ToChangeKind(statusCode),
                    Path.Combine(originFolder, relativePath),
                    committedText));
            }
        }

        return entries;
    }

    private static LedgerChangeKind ToChangeKind(char statusCode) => statusCode switch
    {
        'M' => LedgerChangeKind.Modified,
        'A' => LedgerChangeKind.Added,
        '?' => LedgerChangeKind.Added,
        'D' => LedgerChangeKind.Deleted,
        'R' => LedgerChangeKind.Renamed,
        _ => LedgerChangeKind.Unknown,
    };
}
