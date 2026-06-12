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
        IReadOnlyList<PendingFormRef>? formRefs = null);

    IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null);

    Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin);

    bool Revert(Guid changeId);

    int Revert(string? plugin, string? formKey);

    DrainResult DrainForPlugin(string plugin);

    IReadOnlyList<(string FormKey, string RecordType)> GetStagedFormKeys(string plugin, string? recordType = null);
}
