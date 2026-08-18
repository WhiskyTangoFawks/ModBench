using System.Text.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Edits;

/// <summary>
/// A reindex that failed after the file and DB commit already succeeded. The save is done and
/// pending changes are consumed; only the read model is stale. Named and structured per
/// <c>MEditService/CLAUDE.md</c> / ADR-0026 — never a thrown exception, never stringly-typed.
/// </summary>
public sealed record ReindexFailure(IReadOnlyList<string> Plugins, string Reason);

public abstract record SaveGroupResult
{
    public sealed record NoChanges : SaveGroupResult;
    public sealed record Saved(
        IReadOnlyDictionary<string, SaveResult> ByPlugin,
        ReindexFailure? ReindexFailure = null) : SaveGroupResult;
    public sealed record ImmutablePlugin(string Plugin) : SaveGroupResult;
}

public sealed class PluginSaver(
    IPendingChangeService changes, ISessionManager session, LedgerGroupCommitter ledgerCommitter, ILogger<PluginSaver> logger)
{
    public async Task<SaveGroupResult> Save(Guid memberChangeId)
    {
        var s = session.Session;
        if (s != null)
        {
            // #306: null (no load-order member of this name) refuses here too — proceeding would
            // only fail later, inside SessionManager.RequirePlugin's KeyNotFoundException.
            var refusedPlugin = changes.GetChanges(memberChangeId: memberChangeId)
                .Select(c => c.Plugin)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault(plugin => s.LoadOrderPlugin(plugin) is not { IsImmutable: false });
            if (refusedPlugin != null)
                return new SaveGroupResult.ImmutablePlugin(refusedPlugin);
        }

        // #272 / ADR-0036: byColumn is keyed by the compound column identity, not the bare plugin —
        // the real plugin filename to write/reindex is recovered from the group's own
        // PendingChange.Plugin (never by parsing the compound key) and captured here as
        // writtenPlugins, since saved.ByPlugin's own keys are compound from this point on.
        var writtenPlugins = new List<string>();

        // #371: the group's own pending rows are ExecuteGroupSaveAsync's to delete (before this
        // callback even runs) — byColumn's PendingChange rows are the only place left to read
        // "what did this group touch" from, so they're captured here, inside the callback, not
        // re-derived after the call returns.
        var touchedRecords = new List<LedgerTouchedRecord>();
        var result = await changes.ExecuteGroupSaveAsync(memberChangeId, async byColumn =>
        {
            var prepared = new List<(string Column, PreparedPluginSave Prepared)>();
            try
            {
                foreach (var (column, columnChanges) in byColumn)
                {
                    var realPlugin = columnChanges[0].Plugin;
                    writtenPlugins.Add(realPlugin);
                    prepared.Add((column, await session.PreparePluginSave(realPlugin, columnChanges)));
                    CollectTouchedRecords(columnChanges, touchedRecords);
                }
            }
            catch
            {
                foreach (var (_, p) in prepared) p.Dispose();
                throw;
            }

            return prepared;
        });

        if (result is SaveGroupResult.Saved saved)
        {
            // #371: only reached once the binary write and the pending-change DB transaction have
            // both durably succeeded (ExecuteGroupSaveAsync only returns Saved after its own
            // txn.CommitAsync()) — a validation refusal or a mid-save failure never reaches this
            // line, so the ledger stays unadvanced for those by construction (AC2). Best-effort,
            // never blocking, same as ReindexPlugins below: a git failure must not turn an
            // already-completed save into a reported failure — see LedgerGroupCommitter's own
            // remarks for why it never throws past this call.
            await ledgerCommitter.CommitGroupSaveAsync(touchedRecords, session.Session!.GameRelease).ConfigureAwait(false);

            var plugins = writtenPlugins.ToArray();
            try
            {
                await session.ReindexPlugins(plugins);
            }
            catch (Exception ex)
            {
                // The file and pending-changes transaction already committed. A reindex throw must
                // not turn a completed save into a reported failure — fold it into a named failure
                // so the frontend can surface "saved, but the index is stale" (#127, ADR-0026).
                logger.LogError(ex, "Reindex failed after saving {Plugins}; index is stale", string.Join(", ", plugins));
                return saved with { ReindexFailure = new ReindexFailure(plugins, ex.Message) };
            }
        }

        return result;
    }

    // Same physical-origin-folder resolution EditOrchestrator.VendorOnFirstTouch already does for
    // stage-time vendoring — save-time commit needs the identical (originFolder, pluginFileName)
    // pair to reach the same ledger paths. A plugin with no resolvable origin folder (not in the
    // load order, or a DataDirectory-origin plugin sharing the game's Data folder — #370 Q3) is
    // skipped here exactly as it is at stage time: LedgerGroupCommitter never sees it, so it can
    // never be (mis)reported as ledger-tracked.
    //
    // #373: grouped by FormKey rather than one LedgerTouchedRecord per raw PendingChange row — the
    // same grouping PluginWriter.ApplyFieldChanges/ApplyCreateChanges already do by FormKey for the
    // binary write, needed here because a lifecycle change type is decided per *record*, not per
    // row, and a create's own ledger write (LedgerGroupCommitter.TryStageCreateAsync) needs every
    // field_edit row still pending for that FormKey collected together (template fields, plus any
    // subsequent pre-save edit) rather than handed one at a time.
    private void CollectTouchedRecords(IReadOnlyList<PendingChange> columnChanges, List<LedgerTouchedRecord> into)
    {
        var s = session.Session;
        foreach (var group in columnChanges.GroupBy(c => c.FormKey, StringComparer.OrdinalIgnoreCase))
        {
            var first = group.First();
            var meta = s.LoadOrderPlugin(first.Plugin);
            var originFolder = meta == null ? null : Path.GetDirectoryName(meta.Path);
            if (meta == null || string.IsNullOrEmpty(originFolder)) continue;

            var lifecycle = group.FirstOrDefault(c => PendingChangeConstants.IsLifecycle(c.ChangeType));
            var changeType = lifecycle?.ChangeType ?? PendingChangeConstants.FieldEditChangeType;

            IReadOnlyDictionary<string, JsonElement>? createFields = null;
            if (changeType == PendingChangeConstants.CreateChangeType)
            {
                createFields = group
                    .Where(c => c.ChangeType == PendingChangeConstants.FieldEditChangeType)
                    .ToDictionary(c => c.FieldPath, c => c.NewValue);
            }

            var newFormKey = changeType == PendingChangeConstants.RenumberChangeType
                ? lifecycle!.NewValue.GetString()
                : null;

            into.Add(new LedgerTouchedRecord(
                originFolder, meta.Name, first.RecordType, first.FormKey, changeType, newFormKey, createFields));
        }
    }
}
