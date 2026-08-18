using System.Text.Json.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Ledger;

/// <summary>Which kind of working-tree change a record's ledger entry carries, read honestly off
/// git's own porcelain status code rather than assumed — today's write paths
/// (<see cref="RecordVendor"/>/<see cref="LedgerGroupCommitter"/>) always commit a record's
/// baseline before any dirt is ever written, so <see cref="Modified"/> is the only value the
/// current backend can ever actually produce; the others exist so a future write path (or an
/// external tool editing ledger text directly) is reported for what it is instead of silently
/// mislabeled as a modification.
///
/// <c>[JsonConverter]</c> on the enum itself (not just the global <c>ConfigureHttpJsonOptions</c>
/// converter in <c>Program.cs</c>) is what Swashbuckle's schema generator honors — without it the
/// enum round-trips as a string at runtime but the OpenAPI schema (and therefore generated
/// <c>api.ts</c>) still describes it as an int, same precedent as
/// <c>FormKeyResolutionState</c>/<c>ConflictThis</c>/<c>ConflictAll</c>. Confirmed by regenerating
/// the client before adding this attribute: it emitted <c>0 | 1 | 2 | 3 | 4</c>, not the string
/// literals a caller would actually receive.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
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
public sealed class LedgerStatusQuery(LedgerRepository ledger, ILogger<LedgerStatusQuery> logger)
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
            try
            {
                // #368 review finding 6: this endpoint is specified always-200 (a read-only status
                // projection, not a mutation) — a single origin's git read throwing (a corrupt
                // gitdir, a filesystem hiccup, #372/#373's own future git operations landing behind
                // this) must not blank the whole panel for every *other* plugin too. Per-origin
                // isolation, not per-record: a partial read within one origin folder is no more
                // trustworthy than none, so a mid-origin failure drops that origin's entries as a
                // unit rather than reporting a possibly-incomplete subset of them — ToList() forces
                // CollectForOrigin's lazy iterator to run to completion *before* anything reaches
                // `entries`, so a throw partway through never leaks the records collected ahead of
                // it (AddRange alone would add them one at a time as it enumerates, which a
                // mid-enumeration exception would leave stranded in `entries`).
                var collected = CollectForOrigin(originFolder, group.Select(x => x.Plugin)).ToList();
                entries.AddRange(collected);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "Ledger status read failed for {OriginFolder}; omitted from this response, other origins unaffected",
                    originFolder);
            }
        }

        return entries;
    }

    private IEnumerable<LedgerStatusEntry> CollectForOrigin(string originFolder, IEnumerable<PluginMetadata> plugins)
    {
        if (!ledger.RepoExists(originFolder)) yield break;

        var pluginsByFileName = plugins.ToDictionary(p => p.Name, p => p, StringComparer.OrdinalIgnoreCase);

        foreach (var (statusCode, relativePath) in ledger.WorkingTreeStatus(originFolder))
        {
            // #368 review (mutation axis): a git status line under *.ledger/* that doesn't parse
            // as a record path is exactly the shape of failure that let the non-ASCII quoting bug
            // (review finding 1) drop a genuinely dirty record with nothing anywhere saying so —
            // logged here, not silently skipped, so the next input nobody anticipated is at least
            // observable instead of repeating that exact failure mode.
            if (!LedgerRecordPath.TryParse(relativePath, out var identity))
            {
                logger.LogWarning(
                    "Ledger status entry under {OriginFolder} did not parse as a record path; omitted: {RelativePath}",
                    originFolder, relativePath);
                continue;
            }

            // A record whose ledger path parses cleanly but names a plugin the current session no
            // longer lists in the load order (renamed away, removed from plugins.txt) is a
            // legitimate, ordinary state — not a failure — so no log here, only the skip.
            if (!pluginsByFileName.TryGetValue(identity.PluginFileName, out var plugin)) continue;

            // A record whose ledger path parses but was never committed (not reachable through
            // today's write paths — see LedgerChangeKind's own remarks — but this listing must
            // not assert a HEAD reading that doesn't exist) has nothing to read a committed side
            // from; skipped rather than reported with a fabricated "committed" text.
            if (!ledger.IsTrackedAtHead(originFolder, relativePath)) continue;

            var committedText = ledger.ReadTextAtCommit(originFolder, relativePath, "HEAD");
            yield return new LedgerStatusEntry(
                plugin.Name,
                plugin.Origin,
                identity.RecordType,
                identity.FormKey,
                ToChangeKind(statusCode),
                Path.Combine(originFolder, relativePath),
                committedText);
        }
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
