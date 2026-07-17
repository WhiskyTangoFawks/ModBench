using System.Text.Json;

namespace MEditService.Core.Edits;

public record PendingFormRef(string StagedField, string FieldPath, string TargetFormKey);

public sealed record DrainResult(
    IReadOnlyList<PendingChange> Changes,
    ILookup<string, PendingFormRef> FormRefsByFormKey);

/// <summary>
/// One record's worth of staged field edits to insert or update in the pending-changes buffer.
/// </summary>
public sealed record PendingChangeUpsert(
    string FormKey,
    string Plugin,
    string RecordType,
    Dictionary<string, JsonElement> Fields,
    string Source,
    string? Description,
    Dictionary<string, JsonElement> OldValues,
    IReadOnlyList<PendingFormRef>? FormRefs = null,
    string ChangeType = PendingChangeConstants.FieldEditChangeType,
    string? ParentCell = null,
    string? PlacementGroup = null);

public interface IPendingChangeService
{
    IReadOnlyList<PendingChange> Upsert(PendingChangeUpsert change);

    /// <summary>
    /// Returns the RecordType of a pending <c>$create</c> change for <paramref name="formKey"/>,
    /// or null if it isn't a pending-create target. Used to recognize reference targets that
    /// exist in the current session but aren't committed to the record index yet.
    /// </summary>
    string? GetPendingCreateRecordType(string formKey);

    /// <summary>
    /// Staged changes, optionally narrowed. <paramref name="memberChangeId"/> selects the whole
    /// component the named change belongs to (ADR-0028).
    /// </summary>
    IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null, Guid? memberChangeId = null);

    Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin);

    /// <summary>
    /// Reverts one change on its own, refusing with <see cref="RevertChangeResult.GroupOwned"/> when
    /// its component has more than one member.
    /// </summary>
    RevertChangeResult Revert(Guid changeId);

    int Revert(string? plugin, string? formKey);

    DrainResult DrainForPlugin(string plugin);

    /// <summary>
    /// Atomically saves the component <paramref name="memberChangeId"/> belongs to: deletes its
    /// pending rows and commits <paramref name="prepareAll"/>'s prepared plugin writes together,
    /// rolling both back together if either half fails.
    /// <paramref name="prepareAll"/> runs under the service's single writer lock — it must only prepare
    /// writes (no commit-side-effecting work) and must not call back into this service, or it will deadlock.
    /// </summary>
    Task<SaveGroupResult> ExecuteGroupSaveAsync(
        Guid memberChangeId,
        Func<IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>, Task<IReadOnlyList<(string Plugin, PreparedPluginSave Prepared)>>> prepareAll);

    IReadOnlyList<(string FormKey, string RecordType)> GetStagedFormKeys(string plugin, string? recordType = null);

    /// <summary>
    /// Returns how pending create/renumber changes modify <paramref name="plugin"/>'s native FormKey
    /// set (issue #98): <c>Added</c> is the reserved FormKey of each pending <c>$create</c> plus the
    /// target FormKey of each pending <c>$renumber</c>; <c>Removed</c> is the pre-renumber FormKey each
    /// pending renumber supersedes, so a caller unioning against the committed native set can drop the
    /// stale entry rather than double-counting it. Field-edit/delete/VMAD changes never affect
    /// membership.
    /// </summary>
    (IReadOnlyList<string> Added, IReadOnlyList<string> Removed) GetPendingNativeFormKeyChanges(string plugin);

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
