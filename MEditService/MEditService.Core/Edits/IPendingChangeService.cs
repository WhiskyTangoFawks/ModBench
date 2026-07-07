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
    Guid? GroupId = null,
    string? ParentCell = null,
    string? PlacementGroup = null);

public interface IPendingChangeService
{
    IReadOnlyList<PendingChange> Upsert(PendingChangeUpsert change);

    /// <summary>
    /// Returns the GroupId of the first pending <c>$create</c> change whose FormKey is in <paramref name="formKeys"/>,
    /// or null if none match. Returns null immediately when the list is empty.
    /// </summary>
    Guid? GetCreateGroupIdForAny(IReadOnlyList<string> formKeys);

    /// <summary>
    /// Returns the RecordType of a pending <c>$create</c> change for <paramref name="formKey"/>,
    /// or null if it isn't a pending-create target. Used to recognize reference targets that
    /// exist in the current session but aren't committed to the record index yet.
    /// </summary>
    string? GetPendingCreateRecordType(string formKey);

    IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null, Guid? groupId = null);

    Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin);

    RevertChangeResult Revert(Guid changeId);

    int Revert(string? plugin, string? formKey);

    DrainResult DrainForPlugin(string plugin);

    /// <summary>
    /// Atomically saves a change group: deletes its pending rows and commits <paramref name="prepareAll"/>'s
    /// prepared plugin writes together, rolling both back together if either half fails.
    /// <paramref name="prepareAll"/> runs under the service's single writer lock — it must only prepare
    /// writes (no commit-side-effecting work) and must not call back into this service, or it will deadlock.
    /// </summary>
    Task<SaveGroupResult> ExecuteGroupSaveAsync(
        Guid groupId,
        Func<IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>, Task<IReadOnlyList<(string Plugin, PreparedPluginSave Prepared)>>> prepareAll);

    IReadOnlyList<(string FormKey, string RecordType)> GetStagedFormKeys(string plugin, string? recordType = null);

    IReadOnlyList<ChangeGroup> GetChangeGroups();

    bool RevertGroup(Guid groupId);

    Guid? GetGroupIdForRecord(string formKey, string plugin);

    ChangeGroup StageGroup(string operation, string? description, IReadOnlyList<GroupMember> members);
}
