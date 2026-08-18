using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

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
///
/// <see cref="ChangeType"/> (#373) is one of <see cref="PendingChangeConstants.FieldEditChangeType"/>
/// (the default — every caller before #373 only ever built these), <see cref="PendingChangeConstants.CreateChangeType"/>,
/// <see cref="PendingChangeConstants.DeleteChangeType"/>, or <see cref="PendingChangeConstants.RenumberChangeType"/> —
/// <see cref="LedgerGroupCommitter"/> dispatches its own ledger write shape on this rather than
/// inferring it, the same way <c>PluginWriter</c> dispatches on <c>PendingChange.ChangeType</c>
/// rather than reverse-engineering intent from field shape. <see cref="NewFormKey"/> is populated
/// only for a renumber (the record's new FormKey, wire string form); <see cref="CreateFields"/> only
/// for a create (every <c>field_edit</c> <c>PendingChange</c> still pending for this FormKey at save
/// time — template fields plus any subsequent pre-save edit — collected by
/// <c>PluginSaver.CollectTouchedRecords</c> the same way <c>PluginWriter.ApplyFieldChanges</c>
/// already groups them by FormKey for the binary write).
/// </summary>
public sealed record LedgerTouchedRecord(
    string OriginFolder,
    string PluginFileName,
    string RecordType,
    string FormKey,
    string ChangeType = PendingChangeConstants.FieldEditChangeType,
    string? NewFormKey = null,
    IReadOnlyDictionary<string, JsonElement>? CreateFields = null);

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
/// <c>ChangeGroup</c>) still produces one independent commit per origin folder touched — git itself
/// has no cross-repo transaction to lean on — but #372 closes the inconsistency window that used to
/// leave open: every touched origin is staged and its intended commit journaled
/// (<see cref="LedgerRepository.WriteJournal"/>) before any of them actually commits, so a crash
/// between two origins' commits is recoverable rather than silent (<see cref="LedgerRepository.Recover"/>,
/// run once at startup). The binary has already moved for every touched plugin by the time this
/// class runs at all (see the ordering contract above); what used to be an unrecorded gap between
/// that and each origin's ledger commit is now a journal entry naming exactly which repo is still
/// owed one.
///
/// <b>#373 — create/delete/renumber.</b> Unlike an ordinary field edit, a lifecycle change's own
/// ledger write cannot always be produced by "read what's already sitting in the working tree" —
/// there is either no prior working-tree state to read (create) or the pristine content the write
/// needs has already been erased from the on-disk binary by the time this class runs (delete,
/// renumber: <c>PluginSaver.Save</c> calls this only <i>after</i> the binary write already
/// succeeded — see this class's own ordering contract above). Vendoring a delete/renumber's
/// pristine baseline therefore happens earlier, at stage time
/// (<c>EditOrchestrator.VendorOnFirstTouch</c>, called from <c>DeleteRecords</c>/<c>Renumber</c>
/// with an empty fields dict — a no-op-safe, already-shipped code path, not new machinery); this
/// class only ever reads back what stage time already committed. Create has no such constraint (the
/// record exists in no binary state, before or after, until this save writes it) so its entire
/// representation — construct, apply, serialize, stage — happens here, in one shot, at save time.
/// </summary>
public sealed class LedgerGroupCommitter(
    LedgerRepository ledger, RecordTextCodec codec, ISchemaReflector schemaReflector, ILogger<LedgerGroupCommitter> logger)
{
    // One origin folder's staged-but-not-yet-committed attempt, carrying what Advance needs: the
    // commit message Prepare already derived from what actually got staged, and the delete/renumber
    // backups a *commit-phase* failure (not just a staging-phase one) must still be able to restore
    // (#372 review: moving the commit call out of Prepare's own try/catch means a `git commit`
    // failure is no longer caught by the same block that captured these). Internal, not private —
    // PrepareAsync/AdvanceAsync/AdvanceOneAsync are the #372 test seam (InternalsVisibleTo, same
    // discipline as CommitAttempt's own raw primitives), and a type in their signature must be at
    // least as visible as they are.
    internal sealed record PreparedOrigin(
        LedgerRepository.CommitAttempt Attempt, string Message, List<RemovedFileBackup> RemovedFiles);

    // The journal Entries list is intentionally mutable and shared with every PreparedOrigin in the
    // same group — Advance shrinks it in place (one entry removed per resolved origin) and rewrites
    // the on-disk journal after each one, so the file on disk always reflects exactly what is still
    // genuinely at risk, never a stale entry a live (non-crashed) resolution has already invalidated.
    internal sealed record GroupPrepareResult(
        Guid GroupId, IReadOnlyList<PreparedOrigin> Attempts, List<LedgerRepository.JournalEntry> Entries);

    public async Task CommitGroupSaveAsync(IReadOnlyList<LedgerTouchedRecord> touched, GameRelease release)
    {
        var prepared = await PrepareAsync(touched, release).ConfigureAwait(false);
        await AdvanceAsync(prepared).ConfigureAwait(false);
    }

    // Prepare (#372): stages every touched origin and journals each one's expected content hash
    // *before* any origin commits — so a crash anywhere in Advance still leaves a complete record of
    // every repo this group intended to advance, not just the ones it got to first. Non-atomic
    // across origins was already the design (see class remarks); this phase is what makes that
    // window recoverable instead of silent.
    internal async Task<GroupPrepareResult> PrepareAsync(IReadOnlyList<LedgerTouchedRecord> touched, GameRelease release)
    {
        var groupId = Guid.NewGuid();
        var attempts = new List<PreparedOrigin>();
        var entries = new List<LedgerRepository.JournalEntry>();

        // Deterministic origin order (review-directed, #372) — a lock-ordering invariant the code
        // itself can't show: Prepare now holds every touched origin's gate open simultaneously
        // (unlike the old one-origin-at-a-time loop), so two concurrent group-saves sharing two
        // origins could deadlock if they acquired those gates in opposite orders. Sorting by the
        // same canonical key every acquirer already normalizes to gives every multi-gate acquirer
        // the same total order; a future second one must follow it too, or this guarantee breaks.
        var groups = touched
            .GroupBy(t => Path.GetFullPath(t.OriginFolder), StringComparer.Ordinal)
            .OrderBy(g => g.Key, StringComparer.Ordinal);

        foreach (var group in groups)
        {
            var attempt = await ledger.BeginAttemptAsync(group.Key).ConfigureAwait(false);
            var removedFiles = new List<RemovedFileBackup>();
            try
            {
                var committed = await StageOriginAsync(
                    attempt, [.. group.DistinctBy(t => (t.PluginFileName, t.RecordType, t.FormKey))], release, removedFiles)
                    .ConfigureAwait(false);

                if (committed.Count == 0)
                {
                    // Not necessarily a problem by itself — the common case (nothing this group
                    // touched in this origin is ledger-tracked, e.g. every touched record is
                    // DataDirectory-origin) is expected, legal truth-partition state (ADR-0040), same
                    // as VendorOnFirstTouch's own DataDirectory branch. Still logged unconditionally
                    // (orchestrator-directed, #371 Q3): a group that touched real content but
                    // produced no commit must be findable, never silently treated as "committed".
                    logger.LogInformation(
                        "Save touched {Count} record(s) in {OriginFolder} but none are ledger-tracked; no ledger commit was made for this save",
                        group.Count(), attempt.OriginFolder);
                    attempt.Dispose();
                    continue;
                }

                var message = BuildMessage(committed);
                var expectedHash = ledger.WriteTree(attempt.OriginFolder);
                entries.Add(new LedgerRepository.JournalEntry(attempt.OriginFolder, expectedHash, message));
                ledger.WriteJournal(groupId, entries);
                attempts.Add(new PreparedOrigin(attempt, message, removedFiles));
            }
            catch (Exception ex)
            {
                RestoreAndLogStagingFailure(attempt, removedFiles, ex);
                attempt.Dispose();
            }
        }

        return new GroupPrepareResult(groupId, attempts, entries);
    }

    // Advance (#372): commits every origin Prepare staged and journaled. A commit-phase failure here
    // is still best-effort/non-blocking (see class remarks) — it resolves and logs immediately, the
    // same way a staging-phase failure always has, and its journal entry is removed right along with
    // it: only a genuine process crash (nothing here runs at all) leaves an entry for Recover to find.
    internal async Task AdvanceAsync(GroupPrepareResult prepared)
    {
        foreach (var origin in prepared.Attempts)
            await AdvanceOneAsync(prepared.GroupId, origin, prepared.Entries).ConfigureAwait(false);

        if (prepared.Entries.Count == 0) ledger.DeleteJournal(prepared.GroupId);
    }

    // Split out from AdvanceAsync (#372 test seam): a crash test drives this directly for a subset
    // of a group's prepared origins, leaving the rest exactly as Prepare left them (staged, staged
    // journal entry, attempt neither committed nor disposed) — the same state a real process crash
    // between two Advance iterations would leave, without a real process kill (the existing Ledger/
    // test suite's own idiom: internal primitives reached via InternalsVisibleTo, real git throughout,
    // never a mocked one).
    internal Task AdvanceOneAsync(Guid groupId, PreparedOrigin origin, List<LedgerRepository.JournalEntry> entries)
    {
        using (origin.Attempt)
        {
            try
            {
                origin.Attempt.Commit(origin.Message);
            }
            catch (Exception ex)
            {
                foreach (var backup in origin.RemovedFiles)
                    TryRestoreRemovedFile(backup, ex);

                logger.LogWarning(ex,
                    "Ledger commit failed for a saved group touching {OriginFolder}; the binary write and pending-change save already succeeded, ledger history was not advanced for this save",
                    origin.Attempt.OriginFolder);
            }
        }

        entries.RemoveAll(e => e.OriginFolder == origin.Attempt.OriginFolder);
        ledger.WriteJournal(groupId, entries);
        return Task.CompletedTask;
    }

    // Stages every record for one origin folder — the pre-#372 CommitOriginAsync minus the final
    // attempt.Commit() call, which Advance now owns separately so Prepare can journal every touched
    // origin before any of them commits. Returns which records actually landed something staged
    // (never every touched record — an untracked one is legitimately skipped, see TryStageFieldEdit).
    private async Task<List<LedgerTouchedRecord>> StageOriginAsync(
        LedgerRepository.CommitAttempt attempt, IReadOnlyList<LedgerTouchedRecord> records, GameRelease release,
        List<RemovedFileBackup> removedFiles)
    {
        // #373: a create can be the very first thing this origin folder's ledger ever sees —
        // unlike delete/renumber (which require IsTrackedAtHead, so their stage-time vendor call
        // already guarantees a repo exists) a create has no earlier touch to have created one.
        // EnsureRepo is idempotent (a no-op once the repo exists), so this is free for every
        // other case — but deliberately *not* unconditional: a group whose only touched records
        // are untracked for a legitimate reason (e.g. every one is a DataDirectory-origin plugin —
        // EditOrchestrator.VendorOnFirstTouch's own Q3 branch, #370 — which never vendors at all,
        // since a VMAD struct-op edit now does, #389) must still produce no repo at all, not one
        // fabricated just to discover there was nothing to commit.
        // The known-clean index reset that used to sit here is the attempt scope's own contract
        // now (#393), lazily before its first Stage — which is also what lets an all-untracked
        // batch against a repo-less origin fall through to the "none are ledger-tracked" path
        // below instead of tripping over a reset against a gitdir that doesn't exist.
        if (records.Any(r => r.ChangeType == PendingChangeConstants.CreateChangeType))
            attempt.EnsureRepo();

        var schemas = schemaReflector.GetSchemas(release);
        var committed = new List<LedgerTouchedRecord>();

        foreach (var record in records)
        {
            var handled = record.ChangeType switch
            {
                PendingChangeConstants.CreateChangeType =>
                    await TryStageCreateAsync(attempt, record, schemas, release).ConfigureAwait(false),
                PendingChangeConstants.DeleteChangeType =>
                    TryStageDelete(attempt, record, removedFiles),
                PendingChangeConstants.RenumberChangeType =>
                    await TryStageRenumberAsync(attempt, record, schemas, release, removedFiles).ConfigureAwait(false),
                _ => TryStageFieldEdit(attempt, record),
            };

            if (handled) committed.Add(record);
        }

        return committed;
    }

    // Staging-phase failure (record processing itself threw, e.g. a malformed FormKey) — same
    // restore-then-log contract StageOriginAsync's predecessor (CommitOriginAsync) always had for
    // this case; a commit-phase failure now goes through AdvanceOneAsync's own catch instead, since
    // that call happens later, outside this method entirely.
    private void RestoreAndLogStagingFailure(LedgerRepository.CommitAttempt attempt, List<RemovedFileBackup> removedFiles, Exception ex)
    {
        // Working-tree deletions restored here (review finding, #373): a delete/renumber's
        // own File.Delete *is* this attempt's mutation, not a re-statement of dirt that was
        // already written independently at stage time the way an ordinary field edit's is — so
        // unlike the attempt scope's index-only unstage-on-dispose (sufficient for a plain
        // modify, since the working-tree file it un-stages was never touched by this attempt),
        // a removed file has nothing to fall back on except what this attempt itself saved
        // before deleting it. There is no second chance either: the binary write and
        // pending-change DB transaction have already succeeded and the pending delete/renumber
        // is consumed by the time this runs, so a removed-but-unrestored file would sit that
        // way in the origin's ledger repo permanently — tracked at HEAD, absent from disk —
        // until some unrelated future edit happened to touch the same path. Restores run
        // before the scope's dispose unstages (dispose sits outside this catch), preserving
        // the working-tree-first, index-second rollback order.
        foreach (var backup in removedFiles)
            TryRestoreRemovedFile(backup, ex);

        logger.LogWarning(ex,
            "Ledger commit failed for a saved group touching {OriginFolder}; the binary write and pending-change save already succeeded, ledger history was not advanced for this save",
            attempt.OriginFolder);
    }

    // Captured immediately before a File.Delete this attempt performs (TryStageDelete/
    // TryStageRenumberAsync) so a *later* record's failure in the same attempt can restore exactly
    // this file — never a blunt whole-tree reset, which would also destroy any other record's
    // legitimate, unrelated uncommitted dirt sitting in the same origin folder. The raw text as it
    // stood on disk, not a re-serialization of the in-memory record object: this must reproduce
    // byte-for-byte what was actually lost, not merely something semantically equivalent to it.
    // Internal, not private — see PreparedOrigin's own remarks on why (#372 test seam).
    internal sealed record RemovedFileBackup(string AbsolutePath, string Content);

    // The pre-#373 behaviour, unchanged: not every touched record is ledger-tracked (a
    // DataDirectory-origin plugin has no repo at all — EditOrchestrator.VendorOnFirstTouch's own Q3
    // branch, #370 — and best-effort vendoring can fail at stage time and leave a real edit staged
    // but never reaching the ledger, #370's own VendorOnFirstTouch remarks). A VMAD struct-op edit is
    // no longer an example of this — it vendors on first touch same as a plain field edit, #389.
    // Skipping an untracked record here is correct, not a gap being papered over.
    private static bool TryStageFieldEdit(LedgerRepository.CommitAttempt attempt, LedgerTouchedRecord record)
    {
        var relativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        if (!attempt.IsTrackedAtHead(relativePath)) return false;

        attempt.Stage(relativePath);
        return true;
    }

    // Create (AC1): no prior binary or ledger state exists for this FormKey anywhere — construct a
    // blank record (MajorRecordInstantiator, the same mod-independent, game-agnostic instantiator
    // PluginWriter.TryCreatePlaced already uses, so it covers placed and non-placed records
    // uniformly with no cell/link-cache machinery needed for the *text* representation), apply every
    // field_edit PendingChange still pending for this FormKey (RecordVendor.ApplyFields — the same
    // TryApplyField/OrderForConditionListRestage batch-apply path vendoring already uses, so this
    // cannot drift from what a real save's own PluginWriter.ApplyFieldChanges pass would produce),
    // strip container fields defensively (ADR-0040/#387 amendment), and stage the brand-new path
    // unconditionally — there is no earlier commit at this path to check against.
    private async Task<bool> TryStageCreateAsync(
        LedgerRepository.CommitAttempt attempt, LedgerTouchedRecord record,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        if (!schemas.TryGetValue(record.RecordType, out var schema)) return false;
        if (!FormKey.TryFactory(record.FormKey, out var formKey)) return false;
        if (MajorRecordInstantiator.Activator(formKey, release, schema.RecordType) is not IMajorRecord created) return false;

        if (record.CreateFields is { Count: > 0 } fields)
            RecordVendor.ApplyFields(created, fields, record.RecordType, schemas, release);

        ContainerStripFields.StripInPlace(created);

        var relativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        var absolutePath = Path.Combine(attempt.OriginFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
        await codec.SerializeAsync(created, absolutePath, release).ConfigureAwait(false);

        attempt.Stage(relativePath);
        return true;
    }

    // Delete (AC2): the pristine baseline was already vendored at stage time (EditOrchestrator.
    // DeleteRecords, before the binary write that erases it from disk ever ran — see class remarks).
    // A record that was never successfully vendored (best-effort vendoring failed, or this touched
    // record is a referrer/other change type entirely) has nothing tracked to remove — same
    // "skip, not a gap" contract TryStageFieldEdit already has. Removing the working-tree file and
    // staging the (now tracked) path captures the removal — `git add` on a removed tracked path
    // stages the deletion, no separate `git rm` needed.
    private static bool TryStageDelete(
        LedgerRepository.CommitAttempt attempt, LedgerTouchedRecord record,
        List<RemovedFileBackup> removedFiles)
    {
        var relativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        if (!attempt.IsTrackedAtHead(relativePath)) return false;

        var absolutePath = Path.Combine(attempt.OriginFolder, relativePath);
        if (File.Exists(absolutePath))
        {
            // Captured before deletion — see RemovedFileBackup's own remarks.
            removedFiles.Add(new RemovedFileBackup(absolutePath, File.ReadAllText(absolutePath)));
            File.Delete(absolutePath);
        }

        attempt.Stage(relativePath);
        return true;
    }

    // Renumber (AC3): the old path's pristine baseline was already vendored at stage time, same
    // precondition as delete. Reads the record's *current* ledger text back (whatever stage time
    // left there — pristine, or dirt from an edit staged before the renumber), calls Mutagen's own
    // Duplicate(newFormKey) — the identical primitive PluginWriter.TryRenumberRecord already uses
    // for the binary, so the ledger's content transform can't drift from the real write — strips
    // container fields defensively, serializes under the new path (same directory: a renumber keeps
    // the record on the same plugin, only the local FormID segment of the filename changes), and
    // removes the old file. Both paths are staged into the *same* commit — git's own rename
    // inference reads the two blobs' similarity between this commit and its parent (which, thanks
    // to the stage-time vendor, already holds the old path) and renders it as a rename for any
    // record carrying enough non-identity content to clear its default threshold; a near-empty
    // record (see LedgerLifecycleRenumberTests) legitimately renders as delete+add instead — a
    // known, structural boundary (git's own default threshold, deliberately not overridden — #373
    // orchestrator decision Q1), not a defect here.
    private async Task<bool> TryStageRenumberAsync(
        LedgerRepository.CommitAttempt attempt, LedgerTouchedRecord record,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release, List<RemovedFileBackup> removedFiles)
    {
        if (record.NewFormKey is not { } newFormKeyString) return false;
        if (!schemas.TryGetValue(record.RecordType, out var schema)) return false;
        if (ConcreteRecordTypeResolver.Resolve(schema.RecordType) is not { } concreteType) return false;
        if (!FormKey.TryFactory(newFormKeyString, out var newFormKey)) return false;

        var oldRelativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        if (!attempt.IsTrackedAtHead(oldRelativePath)) return false;

        var oldAbsolutePath = Path.Combine(attempt.OriginFolder, oldRelativePath);
        var current = await codec.DeserializeAsync(oldAbsolutePath, concreteType, release).ConfigureAwait(false);
        var renumbered = (IMajorRecord)current.Duplicate(newFormKey);
        ContainerStripFields.StripInPlace(renumbered);

        var newRelativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, newFormKeyString);
        var newAbsolutePath = Path.Combine(attempt.OriginFolder, newRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(newAbsolutePath)!);
        await codec.SerializeAsync(renumbered, newAbsolutePath, release).ConfigureAwait(false);

        if (File.Exists(oldAbsolutePath))
        {
            // Captured before deletion — see RemovedFileBackup's own remarks.
            removedFiles.Add(new RemovedFileBackup(oldAbsolutePath, await File.ReadAllTextAsync(oldAbsolutePath).ConfigureAwait(false)));
            File.Delete(oldAbsolutePath);
        }

        attempt.Stage(oldRelativePath); // captures the removal
        attempt.Stage(newRelativePath); // captures the add
        return true;
    }

    // Best-effort within a best-effort (review finding, #373): a restore
    // failure here must not mask the original exception CommitOriginAsync is already unwinding
    // from, nor throw past it — a rollback step that itself throws would leave the caller worse off
    // than one that simply logs and moves on.
    private void TryRestoreRemovedFile(RemovedFileBackup backup, Exception original)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(backup.AbsolutePath)!);
            File.WriteAllText(backup.AbsolutePath, backup.Content);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Failed to restore {AbsolutePath} after a failed ledger commit (original failure: {Original})",
                backup.AbsolutePath, original.Message);
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
