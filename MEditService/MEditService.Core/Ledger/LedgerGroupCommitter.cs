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
/// <c>ChangeGroup</c>; cross-repo atomicity is #372, out of scope here) produces one independent,
/// non-atomic commit per origin folder touched — no journal, no rollback coordinating them
/// (orchestrator-directed, #371 Q2): if one origin's commit fails after another's already
/// succeeded, the binary has already moved for both (the write already happened before this class
/// runs at all) while only one origin's ledger advanced — a real but bounded inconsistency window,
/// left for #372 to close, not concealed by refusing to commit at all.
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
    public async Task CommitGroupSaveAsync(IReadOnlyList<LedgerTouchedRecord> touched, GameRelease release)
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
            await gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await CommitOriginAsync(group.Key, [.. group.DistinctBy(t => (t.PluginFileName, t.RecordType, t.FormKey))], release)
                    .ConfigureAwait(false);
            }
            finally
            {
                gate.Release();
            }
        }
    }

    // Non-atomic across origins by design (see class remarks) — a throw for one origin folder must
    // not stop the loop from attempting the rest, and never bubbles to the caller (best-effort).
    private async Task CommitOriginAsync(string originFolder, IReadOnlyList<LedgerTouchedRecord> records, GameRelease release)
    {
        var stagedPaths = new List<string>();
        var removedFiles = new List<RemovedFileBackup>();
        var committed = new List<LedgerTouchedRecord>();
        try
        {
            // #373: a create can be the very first thing this origin folder's ledger ever sees —
            // unlike delete/renumber (which require IsTrackedAtHead, so their stage-time vendor call
            // already guarantees a repo exists) a create has no earlier touch to have created one.
            // EnsureRepo is idempotent (a no-op once the repo exists), so this is free for every
            // other case — but deliberately *not* unconditional: a group whose only touched records
            // are untracked for a legitimate reason (e.g. a VMAD-struct-op-only edit, #389) must
            // still produce no repo at all, not one fabricated just to discover there was nothing to
            // commit (SaveChangeGroup_TouchingOnlyAnUnvendoredVmadStructOp_ProducesNoLedgerCommit).
            if (records.Any(r => r.ChangeType == PendingChangeConstants.CreateChangeType))
                ledger.EnsureRepo(originFolder);

            // Known-clean index before staging anything for this attempt (review finding, #371 —
            // see LedgerRepository.ResetIndexToHead's own remarks): without this, a stray entry an
            // earlier, unrelated failed attempt against this same origin folder left behind — its
            // own UnstagePath never ran, or failed — would get folded into *this* commit, silently
            // including a file this save never touched. A removal and a rename are index operations
            // too (#373) — the same guarantee has to hold for them, not just an ordinary modify.
            ledger.ResetIndexToHead(originFolder);

            var schemas = schemaReflector.GetSchemas(release);

            foreach (var record in records)
            {
                var handled = record.ChangeType switch
                {
                    PendingChangeConstants.CreateChangeType =>
                        await TryStageCreateAsync(originFolder, record, schemas, release, stagedPaths).ConfigureAwait(false),
                    PendingChangeConstants.DeleteChangeType =>
                        TryStageDelete(originFolder, record, stagedPaths, removedFiles),
                    PendingChangeConstants.RenumberChangeType =>
                        await TryStageRenumberAsync(originFolder, record, schemas, release, stagedPaths, removedFiles).ConfigureAwait(false),
                    _ => TryStageFieldEdit(originFolder, record, stagedPaths),
                };

                if (handled) committed.Add(record);
            }

            if (committed.Count == 0)
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

            ledger.CommitStaged(originFolder, BuildMessage(committed));
        }
        catch (Exception ex)
        {
            // Working-tree deletions first, then index (review finding, #373): a delete/renumber's
            // own File.Delete *is* this attempt's mutation, not a re-statement of dirt that was
            // already written independently at stage time the way an ordinary field edit's is — so
            // unlike TryUnstage's index-only rollback (sufficient for a plain modify, since the
            // working-tree file it un-stages was never touched by this attempt), a removed file has
            // nothing to fall back on except what this attempt itself saved before deleting it.
            // There is no second chance either: the binary write and pending-change DB transaction
            // have already succeeded and the pending delete/renumber is consumed by the time this
            // runs, so a removed-but-unrestored file would sit that way in the origin's ledger repo
            // permanently — tracked at HEAD, absent from disk — until some unrelated future edit
            // happened to touch the same path.
            foreach (var backup in removedFiles)
                TryRestoreRemovedFile(backup, ex);

            foreach (var path in stagedPaths)
                TryUnstage(originFolder, path, ex);

            logger.LogWarning(ex,
                "Ledger commit failed for a saved group touching {OriginFolder}; the binary write and pending-change save already succeeded, ledger history was not advanced for this save",
                originFolder);
        }
    }

    // Captured immediately before a File.Delete this attempt performs (TryStageDelete/
    // TryStageRenumberAsync) so a *later* record's failure in the same attempt can restore exactly
    // this file — never a blunt whole-tree reset, which would also destroy any other record's
    // legitimate, unrelated uncommitted dirt sitting in the same origin folder. The raw text as it
    // stood on disk, not a re-serialization of the in-memory record object: this must reproduce
    // byte-for-byte what was actually lost, not merely something semantically equivalent to it.
    private sealed record RemovedFileBackup(string AbsolutePath, string Content);

    // The pre-#373 behaviour, unchanged: not every touched record is ledger-tracked (a change type
    // the ledger never represents e.g. a VMAD struct-op-only edit — #389 — or a DataDirectory-origin
    // plugin with no repo at all). Skipping those is correct, not a gap being papered over.
    private bool TryStageFieldEdit(string originFolder, LedgerTouchedRecord record, List<string> stagedPaths)
    {
        var relativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        if (!ledger.IsTrackedAtHead(originFolder, relativePath)) return false;

        ledger.StagePath(originFolder, relativePath);
        stagedPaths.Add(relativePath);
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
        string originFolder, LedgerTouchedRecord record, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release, List<string> stagedPaths)
    {
        if (!schemas.TryGetValue(record.RecordType, out var schema)) return false;
        if (!FormKey.TryFactory(record.FormKey, out var formKey)) return false;
        if (MajorRecordInstantiator.Activator(formKey, release, schema.RecordType) is not IMajorRecord created) return false;

        if (record.CreateFields is { Count: > 0 } fields)
            RecordVendor.ApplyFields(created, fields, record.RecordType, schemas, release);

        ContainerStripFields.StripInPlace(created);

        var relativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        var absolutePath = Path.Combine(originFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
        await codec.SerializeAsync(created, absolutePath, release).ConfigureAwait(false);

        ledger.StagePath(originFolder, relativePath);
        stagedPaths.Add(relativePath);
        return true;
    }

    // Delete (AC2): the pristine baseline was already vendored at stage time (EditOrchestrator.
    // DeleteRecords, before the binary write that erases it from disk ever ran — see class remarks).
    // A record that was never successfully vendored (best-effort vendoring failed, or this touched
    // record is a referrer/other change type entirely) has nothing tracked to remove — same
    // "skip, not a gap" contract TryStageFieldEdit already has. Removing the working-tree file and
    // staging the (now tracked) path captures the removal — `git add` on a removed tracked path
    // stages the deletion, no separate `git rm` needed.
    private bool TryStageDelete(
        string originFolder, LedgerTouchedRecord record, List<string> stagedPaths, List<RemovedFileBackup> removedFiles)
    {
        var relativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        if (!ledger.IsTrackedAtHead(originFolder, relativePath)) return false;

        var absolutePath = Path.Combine(originFolder, relativePath);
        if (File.Exists(absolutePath))
        {
            // Captured before deletion — see RemovedFileBackup's own remarks.
            removedFiles.Add(new RemovedFileBackup(absolutePath, File.ReadAllText(absolutePath)));
            File.Delete(absolutePath);
        }

        ledger.StagePath(originFolder, relativePath);
        stagedPaths.Add(relativePath);
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
        string originFolder, LedgerTouchedRecord record, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release, List<string> stagedPaths, List<RemovedFileBackup> removedFiles)
    {
        if (record.NewFormKey is not { } newFormKeyString) return false;
        if (!schemas.TryGetValue(record.RecordType, out var schema)) return false;
        if (ConcreteRecordTypeResolver.Resolve(schema.RecordType) is not { } concreteType) return false;
        if (!FormKey.TryFactory(newFormKeyString, out var newFormKey)) return false;

        var oldRelativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, record.FormKey);
        if (!ledger.IsTrackedAtHead(originFolder, oldRelativePath)) return false;

        var oldAbsolutePath = Path.Combine(originFolder, oldRelativePath);
        var current = await codec.DeserializeAsync(oldAbsolutePath, concreteType, release).ConfigureAwait(false);
        var renumbered = (IMajorRecord)current.Duplicate(newFormKey);
        ContainerStripFields.StripInPlace(renumbered);

        var newRelativePath = LedgerRecordPath.For(record.PluginFileName, record.RecordType, newFormKeyString);
        var newAbsolutePath = Path.Combine(originFolder, newRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(newAbsolutePath)!);
        await codec.SerializeAsync(renumbered, newAbsolutePath, release).ConfigureAwait(false);

        if (File.Exists(oldAbsolutePath))
        {
            // Captured before deletion — see RemovedFileBackup's own remarks.
            removedFiles.Add(new RemovedFileBackup(oldAbsolutePath, await File.ReadAllTextAsync(oldAbsolutePath).ConfigureAwait(false)));
            File.Delete(oldAbsolutePath);
        }

        ledger.StagePath(originFolder, oldRelativePath); // captures the removal
        stagedPaths.Add(oldRelativePath);
        ledger.StagePath(originFolder, newRelativePath); // captures the add
        stagedPaths.Add(newRelativePath);
        return true;
    }

    // Best-effort within a best-effort: an UnstagePath failure here must not mask the original
    // exception CommitOriginAsync is already unwinding from, nor throw past it.
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

    // Best-effort within a best-effort, mirroring TryUnstage (review finding, #373): a restore
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
