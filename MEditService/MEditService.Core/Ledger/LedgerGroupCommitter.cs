using Microsoft.Extensions.Logging;

namespace MEditService.Core.Ledger;

/// <summary>
/// One record touched by a saved change group, as <c>PluginSaver</c> already knows it: which
/// origin folder's ledger repo it belongs to (resolved from the session, the same physical-path
/// resolution <c>EditOrchestrator.VendorOnFirstTouch</c> already does), which plugin file the edit
/// was staged onto (<see cref="LedgerRecordPath"/> needs the target plugin, not the record's own
/// origin master — they can legitimately differ, e.g. an override edited through a patch plugin),
/// and the record's type/FormKey. <c>Ledger/</c> has no dependency on <c>Session/</c> (see
/// <c>MEditService/CLAUDE.md</c>'s folder table) — resolving this from a <c>PendingChange</c> is
/// <c>PluginSaver</c>'s job, not this class's.
/// </summary>
public sealed record LedgerTouchedRecord(string OriginFolder, string PluginFileName, string RecordType, string FormKey);

/// <summary>
/// Commits a saved change group's already-staged ledger dirt (ADR-0040/#371): <see cref="RecordVendor"/>
/// writes each tracked record's current field state as uncommitted working-tree dirt on every
/// stage — not just first touch — so by the time a group reaches Save there is nothing left to
/// serialize, only to <c>git add</c> and commit. Callers must invoke this only once both the binary
/// write and the pending-change DB transaction have durably succeeded (mirrors
/// <c>PluginSaver</c>'s existing best-effort Reindex step, which runs from the same post-success
/// branch) — never before, so a validation refusal or a mid-save failure leaves the ledger
/// untouched by construction (AC2). Nothing here re-derives or re-checks that ordering; it trusts
/// the caller the same way <c>PluginSaver.ReindexPlugins</c> already does.
///
/// Best-effort, never blocking — same convention as
/// <c>EditOrchestrator.VendorOnFirstTouch</c>: a git failure here must not turn an
/// already-completed save into a reported failure. Deliberately not wired to any wire DTO
/// (orchestrator-directed, #371 Q3): nothing on the frontend consumes ledger state yet (that's
/// #368); a caller that needs to know what happened reads the log, not the response body.
///
/// One commit per *origin folder*, not per (plugin, origin) column: two plugins sharing one origin
/// folder (an origin folder providing more than one plugin file) share one ledger repo, so their
/// touched records — if both changed in the same group — land in the same commit rather than two
/// independent ones. A group spanning several origin folders (legal per ADR-0028's
/// <c>ChangeGroup</c>; cross-repo atomicity is #372, out of scope here) produces one independent,
/// non-atomic commit per origin folder touched — no journal, no rollback coordinating them
/// (orchestrator-directed, #371 Q2): if one origin's commit fails after another's already
/// succeeded, the binary has already moved for both (the write already happened before this class
/// runs at all) while only one origin's ledger advanced — a real but bounded inconsistency window,
/// left for #372 to close, not concealed by refusing to commit at all.
/// </summary>
public sealed class LedgerGroupCommitter(LedgerRepository ledger, ILogger<LedgerGroupCommitter> logger)
{
    public void CommitGroupSave(IReadOnlyList<LedgerTouchedRecord> touched)
    {
        // Path.GetFullPath, not the raw OriginFolder string: LedgerOriginGate.GateFor and
        // LedgerRepository.PathsFor both normalize the origin folder before keying off it (review
        // finding, #371) — grouping on the raw string here would let two touched records naming the
        // same physical folder in differently-formatted ways split into two groups and produce two
        // commits into what is actually one gitdir, a second way "exactly one commit" could break.
        foreach (var group in touched.GroupBy(t => Path.GetFullPath(t.OriginFolder), StringComparer.Ordinal))
        {
            // Shared with RecordVendor (LedgerOriginGate) — both stage into the same gitdir/index,
            // so a StageEdit vendoring a different record in this same origin folder while this
            // save is committing must not interleave with it.
            var gate = LedgerOriginGate.GateFor(group.Key);
            gate.Wait();
            try
            {
                CommitOrigin(group.Key, [.. group.DistinctBy(t => (t.PluginFileName, t.RecordType, t.FormKey))]);
            }
            finally
            {
                gate.Release();
            }
        }
    }

    // Non-atomic across origins by design (see class remarks) — a throw for one origin folder must
    // not stop the loop from attempting the rest, and never bubbles to the caller (best-effort).
    private void CommitOrigin(string originFolder, IReadOnlyList<LedgerTouchedRecord> records)
    {
        var staged = new List<LedgerTouchedRecord>();
        try
        {
            // Known-clean index before staging anything for this attempt (review finding, #371 —
            // see LedgerRepository.ResetIndexToHead's own remarks): without this, a stray entry an
            // earlier, unrelated failed attempt against this same origin folder left behind — its
            // own UnstagePath never ran, or failed — would get folded into *this* commit, silently
            // including a file this save never touched.
            ledger.ResetIndexToHead(originFolder);

            foreach (var record in records)
            {
                var relativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);

                // Not every touched record is ledger-tracked: a group can carry a change type the
                // ledger never represents (create/delete/renumber — #373), a record vendoring never
                // reached (VMAD struct-op-only edits — #389), or a DataDirectory-origin plugin with
                // no repo at all (IsTrackedAtHead just answers false against a gitdir that was never
                // created, per LedgerRepository's own idempotent-check contract). Skipping those is
                // correct, not a gap being papered over: it is exactly the "no ledger representation
                // yet" state those records are already in; nothing here claims otherwise.
                if (!ledger.IsTrackedAtHead(originFolder, relativePath)) continue;

                ledger.StagePath(originFolder, relativePath);
                staged.Add(record);
            }

            if (staged.Count == 0)
            {
                // Not necessarily a problem by itself — the common case (nothing this group touched
                // in this origin is ledger-tracked, e.g. every touched record is DataDirectory-
                // origin) is expected, legal truth-partition state (ADR-0040), same as
                // VendorOnFirstTouch's own DataDirectory branch. Still logged unconditionally
                // (orchestrator-directed, #371 Q3): a group that touched real content but produced
                // no commit must be findable, never silently treated internally as "committed".
                logger.LogInformation(
                    "Save touched {Count} record(s) in {OriginFolder} but none are ledger-tracked; no ledger commit was made for this save",
                    records.Count, originFolder);
                return;
            }

            ledger.CommitStaged(originFolder, BuildMessage(staged));
        }
        catch (Exception ex)
        {
            foreach (var record in staged)
                TryUnstage(originFolder, LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey), ex);

            logger.LogWarning(ex,
                "Ledger commit failed for a saved group touching {OriginFolder}; the binary write and pending-change save already succeeded, ledger history was not advanced for this save",
                originFolder);
        }
    }

    // Best-effort within a best-effort: an UnstagePath failure here must not mask the original
    // exception CommitOrigin is already unwinding from, nor throw past it.
    private void TryUnstage(string originFolder, string relativePath, Exception original)
    {
        try
        {
            ledger.UnstagePath(originFolder, relativePath);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Failed to unstage {RelativePath} in {OriginFolder} after a failed ledger commit (original failure: {Original})",
                relativePath, originFolder, original.Message);
        }
    }

    // "save: <recordType> <formKey>" for a single record mirrors RecordVendor's own
    // "vendor: <recordType> <formKeyString>" baseline-commit message — same convention, save's own
    // verb. Multi-record groups itemize so the commit is inspectable without a diff.
    private static string BuildMessage(List<LedgerTouchedRecord> records)
    {
        if (records.Count == 1)
        {
            var r = records[0];
            return $"save: {r.RecordType} {r.FormKey}";
        }

        var body = string.Join('\n', records.Select(r => $"- {r.RecordType} {r.FormKey}"));
        return $"save: {records.Count} records\n\n{body}";
    }
}
