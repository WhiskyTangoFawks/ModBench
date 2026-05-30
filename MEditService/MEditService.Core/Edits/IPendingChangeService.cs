using System.Text.Json;

namespace MEditService.Core.Edits;

public interface IPendingChangeService
{
    IReadOnlyList<PendingChange> Upsert(
        string formKey,
        string plugin,
        string recordType,
        Dictionary<string, JsonElement> fields,
        string source,
        string? description,
        Dictionary<string, JsonElement> oldValues);

    IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null);

    Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin);

    bool Revert(Guid changeId);

    int Revert(string? plugin, string? formKey);

    IReadOnlyList<PendingChange> DrainForPlugin(string plugin);
}
