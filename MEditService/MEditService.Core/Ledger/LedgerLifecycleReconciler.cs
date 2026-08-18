using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Ledger;

/// <summary>Answers whether <paramref name="formKeyString"/> resolves in
/// <paramref name="plugin"/>'s own indexed records (<paramref name="origin"/>-scoped) —
/// <see cref="LedgerLifecycleReconciler"/>'s one collaborator across the <c>Session/</c>/
/// <c>Records/</c> boundary (#392), kept a delegate rather than a dependency on
/// <c>IRecordReader</c>/<c>IGameSession</c> directly: <c>Ledger/</c> has no dependency on
/// <c>Session/</c> (<see cref="LedgerGroupCommitter"/>'s own class remarks) and this reconciler is
/// no exception — resolving FormKey existence against the session's real indexed records is
/// <c>SessionManager</c>'s job, not this class's.</summary>
public delegate bool LedgerRenameCandidateFormKeyExists(string recordType, string formKeyString, string plugin, string origin);

/// <summary>
/// Reconciles a ledger tree's lifetime with its plugin's (#392): run at session load (the only
/// point Editing re-observes each origin folder's current physical contents — nothing in Modbench
/// deletes or renames a plugin file itself, so there is no hook to fire on), this finds every
/// <c>&lt;name&gt;.ledger</c> directory an origin's repo still tracks at <c>HEAD</c> whose plugin is
/// no longer physically present, and either renames it onto the one plugin it can prove is a
/// continuation of the same content, or removes it.
///
/// <b>The heuristic and its bias.</b> There is no rename event to observe — only two independent
/// facts at reconciliation time: a tracked tree with no sibling file (an orphan), and a present
/// plugin with no tree of its own (a candidate). Count alone cannot tell a genuine rename from an
/// unrelated plugin that happens to land in the same folder at the same session load (e.g. a
/// same-origin patch plugin that was never itself edited) — pairing on count would attach a dead
/// plugin's history and record text to a plugin whose binary never had it, exactly the
/// ledger/binary divergence ADR-0040 exists to prevent. A candidate therefore only qualifies when
/// every FormKey the orphan's ledger tracks resolves in that candidate's own indexed records
/// (<see cref="LedgerRenameCandidateFormKeyExists"/>) — an authored record (the FormKey's own
/// ModKey is the orphan's own plugin name) is checked under the *candidate's* name, since a
/// self-authored record's effective FormKey moves with the file; an override record (the FormKey's
/// ModKey is some other master) is checked unchanged, since it is master-keyed and a rename of the
/// plugin doing the overriding never changes it. Exactly one qualifying candidate renames; zero or
/// more than one removes — deliberately biased toward removal, since a removal commit still leaves
/// every prior commit reachable in the repo (recoverable, just not connected by <c>--follow</c>),
/// while a wrong rename actively corrupts. A genuine rename whose verification fails for an
/// unrelated reason (e.g. the plugin was also edited externally between sessions) degrades safely
/// into a removal rather than a silent misattachment.
///
/// <b>Scope.</b> Only origin folders that still provide at least one physically present plugin are
/// ever visited — reconciliation walks the plugins the session actually opened, exactly like
/// <see cref="LedgerStatusQuery.GetWorkingTreeChanges"/>'s own origin-folder grouping; it does not
/// enumerate mod folders on its own (<c>Ledger/</c> has no "mod" vocabulary — see the vocabulary
/// boundary in the repo's own CLAUDE.md). An origin folder that has lost every plugin it ever
/// provided is invisible to this pass by construction, a deliberate scope cut, not an oversight.
///
/// Best-effort, never blocking (same convention as <c>EditOrchestrator.VendorOnFirstTouch</c> and
/// <c>LedgerGroupCommitter</c>): a failure reconciling one origin folder must not stop the loop
/// from attempting the rest, and never bubbles to the caller — an unreconciled orphan is left for
/// the next session load, not turned into a failed load.
/// </summary>
public sealed class LedgerLifecycleReconciler(LedgerRepository ledger, ILogger<LedgerLifecycleReconciler> logger)
{
    public async Task ReconcileAsync(
        IReadOnlyList<PluginMetadata> plugins, LedgerRenameCandidateFormKeyExists formKeyExists, CancellationToken cancel = default)
    {
        foreach (var group in plugins
            .Where(p => !string.IsNullOrEmpty(p.Path))
            .Select(p => (Plugin: p, OriginFolder: Path.GetDirectoryName(p.Path)))
            .Where(x => !string.IsNullOrEmpty(x.OriginFolder))
            .GroupBy(x => Path.GetFullPath(x.OriginFolder!), StringComparer.Ordinal))
        {
            try
            {
                await ReconcileOriginAsync(group.Key, [.. group.Select(x => x.Plugin)], formKeyExists, cancel).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "Ledger lifecycle reconciliation failed for {OriginFolder}; left for the next session load",
                    group.Key);
            }
        }
    }

    private async Task ReconcileOriginAsync(
        string originFolder, IReadOnlyList<PluginMetadata> present, LedgerRenameCandidateFormKeyExists formKeyExists, CancellationToken cancel)
    {
        if (!ledger.RepoExists(originFolder)) return;

        var presentNames = new HashSet<string>(present.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);
        var trackedDirs = ledger.LedgerTreeNamesAtHead(originFolder);
        var trackedNames = new HashSet<string>(
            trackedDirs.Select(StripLedgerSuffix), StringComparer.OrdinalIgnoreCase);

        var orphanedNames = trackedDirs.Select(StripLedgerSuffix).Where(n => !presentNames.Contains(n)).ToList();
        if (orphanedNames.Count == 0) return;

        // A candidate is a present plugin that does not already have a ledger tree of its own —
        // one already tracked is never a rename target, whatever its content (AC: "the fix belongs
        // at the lifecycle" — this is what stops the reconciler from ever merging two plugins'
        // independently tracked histories together).
        var candidates = present.Where(p => !trackedNames.Contains(p.Name)).ToList();

        using var attempt = await ledger.BeginAttemptAsync(originFolder, cancel).ConfigureAwait(false);
        var actions = new List<string>();

        foreach (var orphanName in orphanedNames)
        {
            var orphanDir = orphanName + LedgerRecordPath.LedgerSuffix;
            var qualifying = candidates
                .Where(c => AllFormKeysResolveForCandidate(originFolder, orphanDir, orphanName, c, formKeyExists))
                .ToList();

            if (qualifying.Count == 1)
            {
                RenameLedgerTree(attempt, originFolder, orphanName, qualifying[0].Name);
                actions.Add($"renamed ledger tree: {orphanName} -> {qualifying[0].Name}");
            }
            else
            {
                RemoveLedgerTree(attempt, originFolder, orphanName);
                actions.Add($"removed orphaned ledger tree: {orphanName}");
            }
        }

        attempt.Commit(BuildMessage(actions));
    }

    private bool AllFormKeysResolveForCandidate(
        string originFolder, string orphanDir, string orphanPluginName, PluginMetadata candidate,
        LedgerRenameCandidateFormKeyExists formKeyExists)
    {
        foreach (var relativePath in ledger.TrackedRecordPaths(originFolder, orphanDir))
        {
            // Unparseable entries are skipped, not disqualifying — mirrors LedgerStatusQuery's own
            // tolerance for a path this layout did not produce.
            if (!LedgerRecordPath.TryParse(relativePath, out var identity)) continue;

            var checkFormKey = RemapIfAuthoredByOrphan(identity.FormKey, orphanPluginName, candidate.Name);
            if (!formKeyExists(identity.RecordType, checkFormKey, candidate.Name, candidate.Origin))
                return false;
        }

        return true;
    }

    // A self-authored record's FormKey.ModKey is the file that authored it — once that file is
    // renamed, the *same* record's effective FormKey (as the game/Mutagen would read it back) reads
    // under the new name, so this is what the candidate's own indexed records must be asked about.
    // An override record's FormKey.ModKey names some other master entirely and never changes when
    // the plugin doing the overriding is renamed — checked unchanged.
    private static string RemapIfAuthoredByOrphan(string formKeyString, string orphanPluginName, string candidatePluginName)
    {
        var formKey = FormKey.Factory(formKeyString);
        if (!formKey.ModKey.FileName.String.Equals(orphanPluginName, StringComparison.OrdinalIgnoreCase))
            return formKeyString;

        return new FormKey(ModKey.FromFileName(candidatePluginName), formKey.ID).ToString();
    }

    // `git add` on a removed pathspec stages the deletion (same primitive TryStageDelete already
    // relies on) — works whether the directory is still on disk (deleted here first) or was already
    // gone by some other means.
    private static void RemoveLedgerTree(LedgerRepository.CommitAttempt attempt, string originFolder, string pluginName)
    {
        var relativeDir = pluginName + LedgerRecordPath.LedgerSuffix;
        var absoluteDir = Path.Combine(originFolder, relativeDir);
        if (Directory.Exists(absoluteDir)) Directory.Delete(absoluteDir, recursive: true);
        attempt.Stage(relativeDir);
    }

    // Both paths staged into the same commit, mirroring LedgerGroupCommitter's own renumber write:
    // git's content-similarity detection (identical bytes, only the containing folder moved) reads
    // this as a rename in `git log`/`git show`, so history traces across it.
    private static void RenameLedgerTree(LedgerRepository.CommitAttempt attempt, string originFolder, string oldPluginName, string newPluginName)
    {
        var oldRelative = oldPluginName + LedgerRecordPath.LedgerSuffix;
        var newRelative = newPluginName + LedgerRecordPath.LedgerSuffix;
        var oldAbsolute = Path.Combine(originFolder, oldRelative);
        var newAbsolute = Path.Combine(originFolder, newRelative);
        if (Directory.Exists(oldAbsolute)) Directory.Move(oldAbsolute, newAbsolute);
        attempt.Stage(oldRelative); // captures the removal
        attempt.Stage(newRelative); // captures the add
    }

    private static string StripLedgerSuffix(string ledgerDirName) =>
        ledgerDirName[..^LedgerRecordPath.LedgerSuffix.Length];

    private static string BuildMessage(List<string> actions) =>
        actions.Count == 1
            ? $"reconcile: {actions[0]}"
            : $"reconcile: {actions.Count} ledger tree(s)\n\n" + string.Join('\n', actions.Select(a => $"- {a}"));
}
