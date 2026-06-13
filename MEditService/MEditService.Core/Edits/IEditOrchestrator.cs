using System.Text.Json;
using MEditService.Core.Queries;

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
    /// Throws <see cref="ArgumentException"/> for an unknown <paramref name="recordType"/>.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// </summary>
    CreateRecordResult CreateRecord(string plugin, string recordType, string? templateFormKey, string source);
}
