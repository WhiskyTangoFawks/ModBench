using System.Text.Json;

namespace MEditService.Core.Edits;

public interface IEditOrchestrator
{
    StageEditResult StageEdit(
        string formKey,
        string plugin,
        Dictionary<string, JsonElement> fields,
        string source,
        string? description);

    StageEditResult CopyRecordTo(string formKey, string targetPlugin, string source);

    /// <summary>
    /// Reserves a new FormKey for <paramref name="plugin"/>, stages a <c>$create</c> change with a new GroupId,
    /// and returns the reserved FormKey and GroupId.
    /// Returns <see cref="CreateRecordOutcome.InvalidReferences"/> when the template record carries
    /// dangling or type-mismatched FormLink references.
    /// Throws <see cref="ArgumentException"/> for an unknown <paramref name="recordType"/>.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// </summary>
    CreateRecordOutcome CreateRecord(string plugin, string recordType, string? templateFormKey, string source);

    DeleteRecordsResult DeleteRecords(IReadOnlyList<(string FormKey, string Plugin)> targets, string source);

    RenumberResult Renumber(string formKey, uint newFormId, string plugin, string source);
}
