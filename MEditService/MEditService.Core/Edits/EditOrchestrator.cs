using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
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
        string? description,
        string? changeType = null)
    {
        var (earlyOut, session, recordType) = ValidateEditContext(formKey, plugin);
        if (earlyOut != null) return earlyOut;

        var groupId = _changes.GetGroupIdForRecord(formKey, plugin);
        if (groupId is not null)
            return new StageEditResult.BlockedByGroup(groupId.Value);

        if (changeType == PendingChangeConstants.VmadStructOpChangeType)
            return StageVmadStructOps(formKey, plugin, recordType!, fields, source, description);

        var readOnlyFields = fields.Keys
            .Where(f => _writer.IsReadOnly(session!.GameRelease, recordType!, f))
            .ToList();

        var vmadFields = fields.Keys.Where(VmadPath.IsVmadPath).ToList();
        VmadData? vmadData = vmadFields.Count > 0 ? _query.GetVmad(formKey, plugin) : null;
        CollectVmadReadOnlyFields(vmadFields, vmadData, readOnlyFields);

        if (readOnlyFields.Count > 0)
            return new StageEditResult.ReadOnlyFields(readOnlyFields);

        var schemasForValidation = _schemaReflector.GetSchemas(session!.GameRelease);
        var referenceErrors = ValidateReferences(fields, schemasForValidation, recordType!);
        if (referenceErrors.Count > 0)
            return new StageEditResult.InvalidReferences(referenceErrors);

        var currentRecord = _query.GetRecordForPlugin(formKey, plugin);
        var oldValues = new Dictionary<string, JsonElement>();
        if (currentRecord != null)
        {
            foreach (var fv in currentRecord.Fields.Where(fv => fields.ContainsKey(fv.Metadata.Name)))
                oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
        }

        CaptureVmadOldValues(vmadFields, vmadData, oldValues);

        var formRefs = ExtractFormKeyRefs(fields, schemasForValidation, recordType!);

        var distinctRefs = formRefs.Select(r => r.TargetFormKey).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var createGroupId = _changes.GetCreateGroupIdForAny(distinctRefs);

        var staged = _changes.Upsert(formKey, plugin, recordType!, fields, source, description, oldValues, formRefs, groupId: createGroupId);
        return new StageEditResult.Staged(staged);
    }

    // Phase 13.8 structural ops: each field value is an op payload { op, ... } rather than a plain
    // value, so the normal scalar validation/ref-extraction is bypassed in favour of op-aware handling.
    private StageEditResult StageVmadStructOps(
        string formKey, string plugin, string recordType,
        Dictionary<string, JsonElement> fields, string source, string? description)
    {
        var vmadData = _query.GetVmad(formKey, plugin);
        var oldValues = new Dictionary<string, JsonElement>();
        var formRefs = new List<PendingFormRef>();

        foreach (var (path, op) in fields)
        {
            if (op.ValueKind != JsonValueKind.Object
                || !op.TryGetProperty("op", out var opEl) || opEl.GetString() is not string opName)
                return new StageEditResult.RecordNotFound();

            // Route by path shape: "VMAD\<ScriptName>" is a script-level op (add/remove script, set
            // script flags) — staged as-is with no value validation or old-value capture.
            if (VmadPath.TryParseScript(path, out _))
                continue;

            if (!VmadPath.TryParse(path, out var scriptName, out var propName))
                return new StageEditResult.RecordNotFound();

            // add_property targets an existing script — reject early if it's absent.
            if (opName == "add_property" &&
                vmadData?.Scripts.Any(s => string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase)) != true)
                return new StageEditResult.RecordNotFound();

            // Capture the property's current value (if any) for revert display.
            if (FindVmadProperty(vmadData, scriptName, propName) is { } prop)
                oldValues[path] = SerializeVmadOldValue(prop.Value);

            // Register form references carried in the op's value (Object / ArrayOfObject).
            if (op.TryGetProperty("value", out var value))
                ExtractVmadValueRefs(path, value, formRefs);
        }

        var staged = _changes.Upsert(
            formKey, plugin, recordType, fields, source, description,
            oldValues, formRefs, changeType: PendingChangeConstants.VmadStructOpChangeType);
        return new StageEditResult.Staged(staged);
    }

    // VMAD fields: check for Variable/ArrayOfVariable types which are read-only.
    // IsReadOnly returns false for all VMAD paths (it can't know the type without a DB lookup),
    // so we do the type check here using GetVmad.
    private static void CollectVmadReadOnlyFields(
        List<string> vmadFields, VmadData? vmadData, List<string> readOnlyFields)
    {
        foreach (var path in vmadFields)
        {
            if (!VmadPath.TryParse(path, out var scriptName, out var propName) ||
                FindVmadProperty(vmadData, scriptName, propName) is
                {
                    Value.Type: not (
                    "Bool" or "Int" or "Float" or "String" or "Object" or
                    "ArrayOfBool" or "ArrayOfInt" or "ArrayOfFloat" or "ArrayOfString" or "ArrayOfObject")
                })
                readOnlyFields.Add(path);
        }
    }

    private static void CaptureVmadOldValues(
        List<string> vmadFields, VmadData? vmadData, Dictionary<string, JsonElement> oldValues)
    {
        foreach (var path in vmadFields)
        {
            if (!VmadPath.TryParse(path, out var scriptName, out var propName)
                || FindVmadProperty(vmadData, scriptName, propName) is not { } prop) continue;
            oldValues[path] = SerializeVmadOldValue(prop.Value);
        }
    }

    private static VmadNamedValue? FindVmadProperty(VmadData? vmadData, string scriptName, string propName) =>
        vmadData?.Scripts
            .FirstOrDefault(s => string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase))
            ?.Properties.FirstOrDefault(p => string.Equals(p.Name, propName, StringComparison.OrdinalIgnoreCase));

    private static JsonElement SerializeVmadOldValue(VmadPropertyValue v)
    {
        if (v.ListItems != null)
        {
            return v.Type == "ArrayOfObject"
                ? JsonSerializer.SerializeToElement(
                    v.ListItems.Select(i => new { formKey = (string?)i.Value, alias = i.Alias }))
                : JsonSerializer.SerializeToElement(v.ListItems.Select(i => i.Value));
        }
        return v.Type == "Object"
            ? JsonSerializer.SerializeToElement(new { formKey = (string?)v.Value, alias = v.Alias })
            : JsonSerializer.SerializeToElement(v.Value);
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

        var placement = _query.GetPlacement(formKey, winner.Plugin);

        var schemas = _schemaReflector.GetSchemas(session!.GameRelease);
        var formRefs = ExtractFormKeyRefs(fields, schemas, recordType!);
        var staged = _changes.Upsert(formKey, targetPlugin, recordType!, fields, source, null, oldValues, formRefs,
            parentCell: placement?.ParentCell, placementGroup: placement?.PlacementGroup);
        return new StageEditResult.Staged(staged);
    }

    public CreateRecordOutcome CreateRecord(string plugin, string recordType, string? templateFormKey, string source) =>
        CreateRecordCore(plugin, recordType, templateFormKey, source, parentCell: null, placementGroup: null);

    public CreateRecordOutcome CreatePlacedRecord(
        string plugin, string recordType, string parentCell, string placementGroup,
        string? templateFormKey, string source) =>
        CreateRecordCore(plugin, recordType, templateFormKey, source, parentCell, placementGroup);

    private CreateRecordOutcome CreateRecordCore(
        string plugin, string recordType, string? templateFormKey, string source,
        string? parentCell, string? placementGroup)
    {
        var session = _sessionManager.Session
            ?? throw new InvalidOperationException("No session loaded.");

        var schemas = _schemaReflector.GetSchemas(session.GameRelease);
        if (!schemas.ContainsKey(recordType))
            throw new ArgumentException($"Unknown record type '{recordType}'.", nameof(recordType));

        Dictionary<string, JsonElement>? templateFields = null;
        if (templateFormKey != null)
        {
            var winner = _query.GetRecord(templateFormKey)
                ?? throw new ArgumentException($"Template record '{templateFormKey}' not found.", nameof(templateFormKey));

            templateFields = winner.Fields
                .Where(fv => !_writer.IsReadOnly(session.GameRelease, recordType, fv.Metadata.Name))
                .ToDictionary(fv => fv.Metadata.Name, fv => JsonSerializer.SerializeToElement(fv.Value));

            var referenceErrors = ValidateReferences(templateFields, schemas, recordType);
            if (referenceErrors.Count > 0)
                return new CreateRecordOutcome.InvalidReferences(referenceErrors);
        }

        var reservedFormKey = _sessionManager.ReserveFormKey(plugin);
        var groupId = Guid.NewGuid();
        _changes.Upsert(
            reservedFormKey, plugin, recordType,
            new Dictionary<string, JsonElement> { [PendingChangeConstants.CreateFieldPath] = JsonSerializer.SerializeToElement<object?>(null) },
            source, null,
            new Dictionary<string, JsonElement>(),
            formRefs: null,
            changeType: PendingChangeConstants.CreateChangeType,
            groupId: groupId,
            parentCell: parentCell,
            placementGroup: placementGroup);

        if (templateFields != null)
        {
            var templateRefs = ExtractFormKeyRefs(templateFields, schemas, recordType);
            _changes.Upsert(
                reservedFormKey, plugin, recordType,
                templateFields, source, null,
                new Dictionary<string, JsonElement>(),
                templateRefs,
                changeType: PendingChangeConstants.FieldEditChangeType,
                groupId: groupId);
        }

        return new CreateRecordOutcome.Success(reservedFormKey, groupId);
    }

    public DeleteRecordsResult DeleteRecords(IReadOnlyList<(string FormKey, string Plugin)> targets, string source)
    {
        var session = _sessionManager.Session;
        if (session == null) return new DeleteRecordsResult.NoSession();

        // Reject deletes targeting immutable plugins
        foreach (var (_, plugin) in targets)
        {
            var meta = session.Plugins.FirstOrDefault(p =>
                p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
            if (meta?.IsImmutable == true)
                return new DeleteRecordsResult.PluginImmutable(plugin);
        }

        // Check for active pending groups on any target
        var blockedKeys = targets
            .Where(t => _changes.GetGroupIdForRecord(t.FormKey, t.Plugin) != null)
            .Select(t => t.FormKey)
            .ToList();
        if (blockedKeys.Count > 0)
            return new DeleteRecordsResult.BlockedByPendingGroup(blockedKeys);

        var targetFormKeys = targets.Select(t => t.FormKey).ToHashSet(StringComparer.OrdinalIgnoreCase);

        // Scan references to all targets; partition into blocked (immutable) vs. nullifiable (editable)
        var immutablePlugins = session.Plugins
            .Where(p => p.IsImmutable)
            .Select(p => p.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var blocked = new List<BlockedReference>();
        var toNullify = new List<(string SourceFormKey, string SourcePlugin, string FieldPath, string RecordType)>();

        foreach (var (formKey, _) in targets)
        {
            foreach (var refResult in _query.GetReferences(formKey))
            {
                // Skip self-references within the delete batch
                if (targetFormKeys.Contains(refResult.FormKey)) continue;

                if (immutablePlugins.Contains(refResult.Plugin))
                    blocked.Add(new BlockedReference(formKey, refResult.FormKey, refResult.Plugin, refResult.FieldPath, refResult.RecordType, refResult.EditorId));
                else
                    toNullify.Add((refResult.FormKey, refResult.Plugin, refResult.FieldPath, refResult.RecordType));
            }
        }

        if (blocked.Count > 0)
            return new DeleteRecordsResult.BlockedByReferences(blocked);

        // Build group members: one delete change per target + one nullification per editable ref
        var members = new List<GroupMember>();

        foreach (var (formKey, plugin) in targets)
        {
            var recordType = _query.GetRecordType(formKey) ?? "unknown";
            var placement = _query.GetPlacement(formKey, plugin);
            members.Add(new GroupMember(
                formKey, plugin, recordType,
                PendingChangeConstants.DeleteChangeType,
                PendingChangeConstants.DeleteFieldPath,
                PendingChangeConstants.NullElement,
                PendingChangeConstants.NullElement,
                source,
                placement?.ParentCell,
                placement?.PlacementGroup));
        }

        // Group by (record, field) first: two deleted targets can each be referenced by a
        // different element of the *same* array field on the same source record, and staging
        // one GroupMember per reference would have the second overwrite the first's removal
        // (StageGroup upserts on (form_key, plugin, field_path)).
        foreach (var fieldGroup in toNullify.GroupBy(t => (t.SourceFormKey, t.SourcePlugin, TopLevelFieldName(t.FieldPath), t.RecordType)))
        {
            var (sourceFormKey, sourcePlugin, topLevelField, recordType) = fieldGroup.Key;
            var currentRecord = _query.GetRecordForPlugin(sourceFormKey, sourcePlugin)!;
            var fieldMap = currentRecord.Fields.ToDictionary(fv => fv.Metadata.Name, fv => fv.Value);
            var oldValue = JsonSerializer.SerializeToElement(fieldMap[topLevelField]);

            var indices = fieldGroup.Select(t => ParseArrayIndex(t.FieldPath)).Where(i => i is int).Select(i => i!.Value).ToList();
            var newValue = indices.Count > 0
                ? RemoveArrayElements(oldValue, indices)
                : PendingChangeConstants.NullElement;

            members.Add(new GroupMember(
                sourceFormKey, sourcePlugin, recordType,
                PendingChangeConstants.FieldEditChangeType,
                topLevelField,
                oldValue,
                newValue,
                source));
        }

        var group = _changes.StageGroup("delete", null, members);
        return new DeleteRecordsResult.Staged(group);
    }

    public RenumberResult Renumber(string formKey, uint newFormId, string plugin, string source)
    {
        var session = _sessionManager.Session;
        if (session == null) return new RenumberResult.NoSession();

        var pluginMeta = session.Plugins.FirstOrDefault(p =>
            p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase));
        if (pluginMeta?.IsImmutable == true)
            return new RenumberResult.PluginImmutable(plugin);

        var recordType = _query.GetRecordType(formKey);
        if (recordType == null) return new RenumberResult.RecordNotFound();

        var newFormKey = $"{newFormId:X6}:{plugin}";

        var immutablePlugins = session.Plugins
            .Where(p => p.IsImmutable)
            .Select(p => p.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var allRefs = _query.GetReferences(formKey).ToList();

        var immutableBlockers = allRefs
            .Where(r => immutablePlugins.Contains(r.Plugin))
            .ToList();
        if (immutableBlockers.Count > 0)
            return new RenumberResult.ImmutableReferences(immutableBlockers);

        if (_query.GetRecordType(newFormKey) != null)
            return new RenumberResult.FormIdInUse();

        var members = new List<GroupMember>();

        // The renumber change for the record itself
        members.Add(new GroupMember(
            formKey, plugin, recordType,
            PendingChangeConstants.RenumberChangeType,
            PendingChangeConstants.RenumberFieldPath,
            JsonSerializer.SerializeToElement(formKey),
            JsonSerializer.SerializeToElement(newFormKey),
            source));

        // FieldEdit changes for cross-plugin editable references only
        var crossPluginRefs = allRefs
            .Where(r => !r.Plugin.Equals(plugin, StringComparison.OrdinalIgnoreCase) &&
                        !immutablePlugins.Contains(r.Plugin))
            .ToList();

        foreach (var fieldGroup in crossPluginRefs.GroupBy(r => (r.FormKey, r.Plugin, TopLevelFieldName(r.FieldPath), r.RecordType)))
        {
            var (sourceFormKey, sourcePlugin, topLevelField, refRecordType) = fieldGroup.Key;
            var currentRecord = _query.GetRecordForPlugin(sourceFormKey, sourcePlugin)!;
            var fieldMap = currentRecord.Fields.ToDictionary(fv => fv.Metadata.Name, fv => fv.Value);
            var oldValue = JsonSerializer.SerializeToElement(fieldMap[topLevelField]);
            var newValue = ReplaceFormKey(oldValue, formKey, newFormKey);

            members.Add(new GroupMember(
                sourceFormKey, sourcePlugin, refRecordType,
                PendingChangeConstants.FieldEditChangeType,
                topLevelField,
                oldValue,
                newValue,
                source));
        }

        var group = _changes.StageGroup("renumber", null, members);
        return new RenumberResult.Staged(group);
    }

    private static JsonElement ReplaceFormKey(JsonElement element, string oldFormKey, string newFormKey) =>
        element.ValueKind switch
        {
            JsonValueKind.String when element.GetString()!.Equals(oldFormKey, StringComparison.OrdinalIgnoreCase) =>
                JsonSerializer.SerializeToElement(newFormKey),
            JsonValueKind.Array =>
                JsonSerializer.SerializeToElement(
                    element.EnumerateArray()
                        .Select(e => ReplaceFormKey(e, oldFormKey, newFormKey))
                        .ToList()),
            JsonValueKind.Object =>
                JsonSerializer.SerializeToElement(
                    element.EnumerateObject()
                        .ToDictionary(p => p.Name, p => ReplaceFormKey(p.Value, oldFormKey, newFormKey))),
            _ => element
        };

    private static string TopLevelFieldName(string fieldPath) =>
        fieldPath.Split(['.', '['], 2)[0];

    private static readonly Regex BracketIndex = new(@"\[(\d+)\]", RegexOptions.Compiled);

    private static int? ParseArrayIndex(string fieldPath)
    {
        var m = BracketIndex.Match(fieldPath);
        return m.Success ? int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) : null;
    }

    private static JsonElement RemoveArrayElements(JsonElement array, IReadOnlyList<int> indices)
    {
        var items = array.EnumerateArray().ToList();
        foreach (var index in indices.Distinct().OrderByDescending(i => i))
            items.RemoveAt(index);
        return JsonSerializer.SerializeToElement(items);
    }

    private List<ReferenceValidationError> ValidateReferences(
        Dictionary<string, JsonElement> fields,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string recordType)
    {
        var errors = new List<ReferenceValidationError>();
        if (!schemas.TryGetValue(recordType, out var schema)) return errors;
        var colsByName = schema.RecordColumns.ToDictionary(c => c.Name);
        string? LookupRecordType(string fk)
        {
            var committed = _query.GetRecordType(fk);
            if (committed != null) return committed;
            return _changes.GetPendingCreateRecordType(fk);
        }
        foreach (var (fieldPath, newValue) in fields)
        {
            if (colsByName.TryGetValue(fieldPath, out var col))
                errors.AddRange(ReferenceValidator.Validate(col, _ => (object?)newValue, LookupRecordType));
        }
        return errors;
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
            if (VmadPath.IsVmadPath(fieldPath))
                ExtractVmadValueRefs(fieldPath, newValue, result);
            else if (colsByName.TryGetValue(fieldPath, out var col))
                FormRefPathBuilder.Walk(col, _ => (object?)newValue, (path, fk) =>
                    result.Add(new PendingFormRef(fieldPath, path, fk)));
        }
        return result;
    }

    // Extracts Object / ArrayOfObject FormKey refs from a VMAD value in the { formKey, alias } shape.
    private static void ExtractVmadValueRefs(string fieldPath, JsonElement value, List<PendingFormRef> into)
    {
        if (value.ValueKind == JsonValueKind.Object &&
            value.TryGetProperty("formKey", out var fkEl) &&
            fkEl.ValueKind == JsonValueKind.String && fkEl.GetString() is string fk)
        {
            into.Add(new PendingFormRef(fieldPath, fieldPath, fk));
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in value.EnumerateArray())
                if (el.ValueKind == JsonValueKind.Object &&
                    el.TryGetProperty("formKey", out var elFkEl) &&
                    elFkEl.GetString() is string elFk)
                    into.Add(new PendingFormRef(fieldPath, fieldPath, elFk));
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
