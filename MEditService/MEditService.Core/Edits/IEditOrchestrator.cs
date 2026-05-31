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
}
