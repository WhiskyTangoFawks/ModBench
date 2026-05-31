using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Session;

namespace MEditService.Core.Edits;

public sealed class EditOrchestrator : IEditOrchestrator
{
    private readonly ISessionManager _sessionManager;
    private readonly IRecordQueryService _query;
    private readonly IPluginWriter _writer;
    private readonly IPendingChangeService _changes;

    public EditOrchestrator(
        ISessionManager sessionManager,
        IRecordQueryService query,
        IPluginWriter writer,
        IPendingChangeService changes)
    {
        _sessionManager = sessionManager;
        _query = query;
        _writer = writer;
        _changes = changes;
    }

    public StageEditResult StageEdit(
        string formKey,
        string plugin,
        Dictionary<string, JsonElement> fields,
        string source,
        string? description)
    {
        var session = _sessionManager.Session;
        if (session == null) return new StageEditResult.NoSession();

        var pluginMeta = session.Plugins.FirstOrDefault(p =>
            p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
        if (pluginMeta?.IsImmutable == true)
            return new StageEditResult.PluginImmutable(plugin);

        var recordType = _query.GetRecordType(formKey);
        if (recordType == null) return new StageEditResult.RecordNotFound();

        var readOnlyFields = fields.Keys
            .Where(f => _writer.IsReadOnly(session.GameRelease, recordType, f))
            .ToList();
        if (readOnlyFields.Count > 0)
            return new StageEditResult.ReadOnlyFields(readOnlyFields);

        var currentRecord = _query.GetRecordForPlugin(formKey, plugin);
        var oldValues = new Dictionary<string, JsonElement>();
        if (currentRecord != null)
        {
            foreach (var fv in currentRecord.Fields)
            {
                if (fields.ContainsKey(fv.Metadata.Name))
                    oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
            }
        }

        var staged = _changes.Upsert(formKey, plugin, recordType, fields, source, description, oldValues);
        return new StageEditResult.Staged(staged);
    }

    public StageEditResult CopyRecordTo(string formKey, string targetPlugin, string source)
    {
        var session = _sessionManager.Session;
        if (session == null) return new StageEditResult.NoSession();

        var pluginMeta = session.Plugins.FirstOrDefault(p =>
            p.Name.Equals(targetPlugin, StringComparison.OrdinalIgnoreCase));
        if (pluginMeta?.IsImmutable == true)
            return new StageEditResult.PluginImmutable(targetPlugin);

        var recordType = _query.GetRecordType(formKey);
        if (recordType == null) return new StageEditResult.RecordNotFound();

        var winner = _query.GetRecord(formKey);
        if (winner == null) return new StageEditResult.RecordNotFound();

        var fields = winner.Fields.ToDictionary(
            fv => fv.Metadata.Name,
            fv => JsonSerializer.SerializeToElement(fv.Value));

        var currentTarget = _query.GetRecordForPlugin(formKey, targetPlugin);
        var oldValues = new Dictionary<string, JsonElement>();
        if (currentTarget != null)
        {
            foreach (var fv in currentTarget.Fields)
                oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
        }

        var staged = _changes.Upsert(formKey, targetPlugin, recordType, fields, source, null, oldValues);
        return new StageEditResult.Staged(staged);
    }
}
