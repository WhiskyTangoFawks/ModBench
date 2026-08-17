using System.Text.Json;
using MEditService.Core.Session;

namespace MEditService.Core.Edits;

public record PendingFormRef(string StagedField, string FieldPath, string TargetFormKey);

/// <summary>
/// One record's worth of staged field edits to insert or update in the pending-changes buffer.
/// Input command only — never serialized to the wire; the response type is <see cref="PendingChange"/>.
/// </summary>
// Origin (#271 / ADR-0036): binds the staged edit to the compound identity, same as the committed
// record index — EditOrchestrator resolves it from the session's PluginMetadata before
// construction. Required (#275): every construction must say which origin. Kept in its original
// trailing position rather than reordered before FormRefs/ChangeType/ParentCell/PlacementGroup —
// FormRefs and ChangeType are usually passed positionally right after OldValues by existing
// callers, and ChangeType shares Origin's own `string` type, so moving Origin earlier would let an
// existing positional caller's argument silently land in the wrong slot instead of failing to
// compile. Those four lose their own defaults as a consequence (C# requires every required
// parameter to precede every optional one) — a small, safe widening: existing callers relying on
// those defaults now name them explicitly with the same value the default used to supply.
public sealed record PendingChangeUpsert(
    string FormKey,
    string Plugin,
    string RecordType,
    Dictionary<string, JsonElement> Fields,
    string Source,
    string? Description,
    Dictionary<string, JsonElement> OldValues,
    IReadOnlyList<PendingFormRef>? FormRefs,
    string ChangeType,
    string? ParentCell,
    string? PlacementGroup,
    string Origin);

public interface IPendingChangeService
{
    IReadOnlyList<PendingChange> Upsert(PendingChangeUpsert change);

    /// <summary>
    /// Returns the RecordType of a pending <c>$create</c> change for <paramref name="formKey"/>,
    /// or null if it isn't a pending-create target. Used to recognize reference targets that
    /// exist in the current session but aren't committed to the record index yet.
    /// </summary>
    string? GetPendingCreateRecordType(string formKey);

    // origin (#272 / ADR-0036) on every method below: nullable and independent of plugin/formKey,
    // unlike every other origin parameter in this file — these are *filters*, not identity fields,
    // so they default to "no filter" (preserving today's exact filename-only behavior for every
    // existing caller) rather than to PluginOrigin.DataDirectory, which would wrongly exclude every
    // row for a mod-provided (non-Data) origin plugin.

    /// <summary>
    /// Staged changes, optionally narrowed. <paramref name="memberChangeId"/> selects the whole
    /// component the named change belongs to (ADR-0028).
    /// </summary>
    IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null, Guid? memberChangeId = null, string? origin = null);

    Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin, string? origin = null);

    /// <summary>
    /// Deletes pending changes (and their form references) on <paramref name="formKey"/>/
    /// <paramref name="plugin"/> whose field_path starts with <paramref name="prefix"/>. Used when a
    /// whole-subtree restage supersedes previously-staged per-field edits within that subtree — e.g.
    /// an add/remove/move condition-list restage superseding stale <c>CTDA\&lt;fieldPath&gt;\N\...</c>
    /// edits whose indices are no longer trustworthy (#153, ADR-0019). Returns the number of rows
    /// removed.
    /// </summary>
    int RemoveFieldsWithPrefix(string formKey, string plugin, string prefix, string? origin = null);

    /// <summary>
    /// Reverts one change on its own, refusing with <see cref="RevertChangeResult.GroupOwned"/> when
    /// its component has more than one member.
    /// </summary>
    RevertChangeResult Revert(Guid changeId);

    int Revert(string? plugin, string? formKey, string? origin = null);

    /// <summary>
    /// Atomically saves the component <paramref name="memberChangeId"/> belongs to: deletes its
    /// pending rows and commits <paramref name="prepareAll"/>'s prepared plugin writes together,
    /// rolling both back together if either half fails.
    /// <paramref name="prepareAll"/> runs under the service's single writer lock — it must only prepare
    /// writes (no commit-side-effecting work) and must not call back into this service, or it will deadlock.
    /// </summary>
    // #272 / ADR-0036: the dictionary prepareAll receives is keyed by the compound column identity
    // derived via ColumnKey, not the bare plugin — a group sharing a filename with another but
    // differing in origin lands as an independent entry. The returned tuple's Column mirrors that
    // same identity; the real plugin filename to write is recovered from the group's own
    // PendingChange.Plugin field.
    Task<SaveGroupResult> ExecuteGroupSaveAsync(
        Guid memberChangeId,
        Func<IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>, Task<IReadOnlyList<(string Column, PreparedPluginSave Prepared)>>> prepareAll);

    IReadOnlyList<(string FormKey, string RecordType)> GetStagedFormKeys(string plugin, string? recordType = null, string? origin = null);

    /// <summary>
    /// Distinct FormKeys referenced by anything currently staged for <paramref name="plugin"/> —
    /// every <c>target_form_key</c> in <c>pending_form_references</c> whose <c>source_plugin</c>/
    /// <c>source_origin</c> match, regardless of which staged record or field carries the
    /// reference. #336/ADR-0038: this is the reference half of effective masters (the other half
    /// is each staged record's own origin, from <see cref="GetStagedFormKeys"/>'s FormKeys) — the
    /// same data the change-group dependency graph already tracks (<c>PendingChangeGraph</c>),
    /// read here for a different purpose. origin (#333/ADR-0036) scopes it the same as
    /// <see cref="GetStagedFormKeys"/>'s: two same-filename, different-origin plugins never pool
    /// their staged references.
    /// </summary>
    IReadOnlyList<string> GetStagedFormRefTargets(string plugin, string? origin = null);

    /// <summary>
    /// Returns how pending create/renumber changes modify <paramref name="plugin"/>'s native FormKey
    /// set (issue #98): <c>Added</c> is the reserved FormKey of each pending <c>$create</c> plus the
    /// target FormKey of each pending <c>$renumber</c>; <c>Removed</c> is the pre-renumber FormKey each
    /// pending renumber supersedes, so a caller unioning against the committed native set can drop the
    /// stale entry rather than double-counting it. Field-edit/delete/VMAD changes never affect
    /// membership.
    /// </summary>
    (IReadOnlyList<string> Added, IReadOnlyList<string> Removed) GetPendingNativeFormKeyChanges(string plugin, string? origin = null);

    /// <summary>
    /// One <see cref="ChangeGroup"/> per connected component of the pending-change dependency graph
    /// (ADR-0028) — derived, not stored. Every pending change is in exactly one; a change nothing
    /// depends on is a group of one. Each group's <c>Id</c> is one of its member change ids.
    /// </summary>
    IReadOnlyList<ChangeGroup> GetChangeGroups();

    /// <summary>
    /// Reverts the whole component <paramref name="memberChangeId"/> belongs to. False when no such
    /// change is pending.
    /// </summary>
    bool RevertGroup(Guid memberChangeId);

    /// <summary>
    /// Stages <paramref name="members"/> atomically as individual pending changes. No group is
    /// declared — the returned <see cref="ChangeGroup"/> is derived from the staged rows, and members
    /// that depend on nothing of each other's land in separate groups regardless of being staged by
    /// one call (ADR-0028). Returns the group the first member landed in.
    /// </summary>
    ChangeGroup StageChanges(IReadOnlyList<GroupMember> members);
}
