using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;
using MEditService.Core.Records;
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

        var groupId = _changes.GetGroupIdForRecord(formKey, plugin);
        if (groupId is not null)
            return new StageEditResult.BlockedByGroup(groupId.Value);

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

        var distinctRefs = formRefs.Select(r => r.TargetFormKey).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var createGroupId = _changes.GetCreateGroupIdForAny(distinctRefs);

        var staged = _changes.Upsert(formKey, plugin, recordType!, fields, source, description, oldValues, formRefs, groupId: createGroupId);
        return new StageEditResult.Staged(staged);
    }

    public StageEditResult CopyRecordTo(string formKey, string targetPlugin, string source)
    {
        var (earlyOut, session, recordType) = ValidateEditContext(formKey, targetPlugin);
        if (earlyOut != null) return earlyOut;

        var groupId = _changes.GetGroupIdForRecord(formKey, targetPlugin);
        if (groupId is not null)
            return new StageEditResult.BlockedByGroup(groupId.Value);

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

    public CreateRecordResult CreateRecord(string plugin, string recordType, string? templateFormKey, string source)
    {
        var session = _sessionManager.Session
            ?? throw new InvalidOperationException("No session loaded.");

        var schemas = _schemaReflector.GetSchemas(session.GameRelease);
        if (!schemas.ContainsKey(recordType))
            throw new ArgumentException($"Unknown record type '{recordType}'.", nameof(recordType));

        var reservedFormKey = _sessionManager.ReserveFormKey(plugin);

        var groupId = Guid.NewGuid();
        _changes.Upsert(
            reservedFormKey, plugin, recordType,
            new Dictionary<string, JsonElement> { [PendingChangeConstants.CreateFieldPath] = JsonSerializer.SerializeToElement<object?>(null) },
            source, null,
            new Dictionary<string, JsonElement>(),
            formRefs: null,
            changeType: PendingChangeConstants.CreateChangeType,
            groupId: groupId);

        if (templateFormKey != null)
        {
            var winner = _query.GetRecord(templateFormKey)
                ?? throw new ArgumentException($"Template record '{templateFormKey}' not found.", nameof(templateFormKey));

            var templateFields = winner.Fields
                .Where(fv => !_writer.IsReadOnly(session.GameRelease, recordType, fv.Metadata.Name))
                .ToDictionary(fv => fv.Metadata.Name, fv => JsonSerializer.SerializeToElement(fv.Value));
            var templateRefs = ExtractFormKeyRefs(templateFields, schemas, recordType);
            _changes.Upsert(
                reservedFormKey, plugin, recordType,
                templateFields, source, null,
                new Dictionary<string, JsonElement>(),
                templateRefs,
                changeType: "field_edit",
                groupId: groupId);
        }

        return new CreateRecordResult(reservedFormKey, groupId);
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
                FormRefPathBuilder.Walk(col, _ => (object?)newValue, (path, fk) =>
                    result.Add(new PendingFormRef(fieldPath, path, fk)));
        }
        return result;
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
