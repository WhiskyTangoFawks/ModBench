using System.Text.Json;

namespace MEditService.Core.Edits;

public record PendingFormRef(string StagedField, string FieldPath, string TargetFormKey);

public sealed record DrainResult(
    IReadOnlyList<PendingChange> Changes,
    ILookup<string, PendingFormRef> FormRefsByFormKey);

public interface IPendingChangeService
{
    IReadOnlyList<PendingChange> Upsert(
        string formKey,
        string plugin,
        string recordType,
        Dictionary<string, JsonElement> fields,
        string source,
        string? description,
        Dictionary<string, JsonElement> oldValues,
        IReadOnlyList<PendingFormRef>? formRefs = null,
        string changeType = PendingChangeConstants.FieldEditChangeType,
        Guid? groupId = null,
        string? parentCell = null,
        string? placementGroup = null);

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

    Task<SaveGroupResult> ExecuteGroupSaveAsync(
        Guid groupId,
        Func<IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>, Task<IReadOnlyDictionary<string, SaveResult>>> writeAll);

    IReadOnlyList<(string FormKey, string RecordType)> GetStagedFormKeys(string plugin, string? recordType = null);

    IReadOnlyList<ChangeGroup> GetChangeGroups();

    bool RevertGroup(Guid groupId);

    Guid? GetGroupIdForRecord(string formKey, string plugin);

    ChangeGroup StageGroup(string operation, string? description, IReadOnlyList<GroupMember> members);
}
