using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Session;

namespace MEditService.Core.Edits;

public sealed class EditOrchestrator : IEditOrchestrator
{
    private readonly ISessionManager _sessionManager;
    private readonly IRecordQueryService _query;
    private readonly IPluginWriter _writer;
    private readonly IPendingChangeService _changes;
    private readonly ISchemaReflector _schemaReflector;

    public EditOrchestrator(
        ISessionManager sessionManager,
        IRecordQueryService query,
        IPluginWriter writer,
        IPendingChangeService changes,
        ISchemaReflector schemaReflector)
    {
        _sessionManager = sessionManager;
        _query = query;
        _writer = writer;
        _changes = changes;
        _schemaReflector = schemaReflector;
    }

    public StageEditResult StageEdit(
        string formKey,
        string plugin,
        Dictionary<string, JsonElement> fields,
        string source,
        string? description)
    {
        var (earlyOut, session, recordType) = ValidateEditContext(formKey, plugin);
        if (earlyOut != null) return earlyOut;

        var readOnlyFields = fields.Keys
            .Where(f => _writer.IsReadOnly(session!.GameRelease, recordType!, f))
            .ToList();
        if (readOnlyFields.Count > 0)
            return new StageEditResult.ReadOnlyFields(readOnlyFields);

        var currentRecord = _query.GetRecordForPlugin(formKey, plugin);
        var oldValues = new Dictionary<string, JsonElement>();
        if (currentRecord != null)
        {
            foreach (var fv in currentRecord.Fields.Where(fv => fields.ContainsKey(fv.Metadata.Name)))
                oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
        }

        var schemas = _schemaReflector.GetSchemas(session!.GameRelease);
        var formRefs = ExtractFormKeyRefs(fields, schemas, recordType!);
        var staged = _changes.Upsert(formKey, plugin, recordType!, fields, source, description, oldValues, formRefs);
        return new StageEditResult.Staged(staged);
    }

    public StageEditResult CopyRecordTo(string formKey, string targetPlugin, string source)
    {
        var (earlyOut, session, recordType) = ValidateEditContext(formKey, targetPlugin);
        if (earlyOut != null) return earlyOut;

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

        var schemas = _schemaReflector.GetSchemas(session!.GameRelease);
        var formRefs = ExtractFormKeyRefs(fields, schemas, recordType!);
        var staged = _changes.Upsert(formKey, targetPlugin, recordType!, fields, source, null, oldValues, formRefs);
        return new StageEditResult.Staged(staged);
    }

    private static List<PendingFormRef> ExtractFormKeyRefs(
        Dictionary<string, JsonElement> fields,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string recordType)
    {
        var result = new List<PendingFormRef>();
        if (!schemas.TryGetValue(recordType, out var schema)) return result;
        var colsByName = schema.RecordColumns.ToDictionary(c => c.Name);
        foreach (var (fieldPath, newValue) in fields)
        {
            if (colsByName.TryGetValue(fieldPath, out var col))
                result.AddRange(ExtractRefsForColumn(fieldPath, newValue, col));
        }
        return result;
    }

    private static IEnumerable<PendingFormRef> ExtractRefsForColumn(
        string fieldPath, JsonElement newValue, ColumnSpec col)
    {
        if (col.ApiType == "formKey")
        {
            if (newValue.ValueKind == JsonValueKind.String)
            {
                var val = newValue.GetString();
                if (val != null && val != "Null")
                    yield return new PendingFormRef(fieldPath, fieldPath, val);
            }
        }
        else if (col.ApiType == "array" && col.ElementType?.Type == "formKey"
                 && newValue.ValueKind == JsonValueKind.Array)
        {
            var idx = 0;
            foreach (var elem in newValue.EnumerateArray())
            {
                if (elem.ValueKind == JsonValueKind.String)
                {
                    var val = elem.GetString();
                    if (val != null && val != "Null")
                        yield return new PendingFormRef(fieldPath, $"{fieldPath}[{idx}]", val);
                }
                idx++;
            }
        }
        else if (col.ApiType == "array" && col.ElementType?.Type == "struct"
                 && newValue.ValueKind == JsonValueKind.Array)
        {
            var idx = 0;
            foreach (var elem in newValue.EnumerateArray())
            {
                if (elem.ValueKind == JsonValueKind.Object)
                {
                    foreach (var subField in col.ElementType.Fields ?? [])
                    {
                        if (subField.Type != "formKey"
                            || !elem.TryGetProperty(subField.Name, out var prop)
                            || prop.ValueKind != JsonValueKind.String) continue;
                        var val = prop.GetString();
                        if (val == null || val == "Null") continue;
                        yield return new PendingFormRef(fieldPath, $"{fieldPath}[{idx}].{subField.Name}", val);
                    }
                }
                idx++;
            }
        }
    }

    private (StageEditResult? earlyOut, IGameSession? session, string? recordType) ValidateEditContext(
        string formKey, string plugin)
    {
        var session = _sessionManager.Session;
        if (session == null) return (new StageEditResult.NoSession(), null, null);

        var pluginMeta = session.Plugins.FirstOrDefault(p =>
            p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
        if (pluginMeta?.IsImmutable == true)
            return (new StageEditResult.PluginImmutable(plugin), null, null);

        var recordType = _query.GetRecordType(formKey);
        if (recordType == null) return (new StageEditResult.RecordNotFound(), null, null);

        return (null, session, recordType);
    }
}
