using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Core.Edits;

public sealed partial class EditOrchestrator(
    ISessionManager sessionManager,
    IRecordQueryService query,
    IPluginWriter writer,
    IPendingChangeService changes,
    ISchemaReflector schemaReflector) : IEditOrchestrator
{
    private readonly ISessionManager _sessionManager = sessionManager;
    private readonly IRecordQueryService _query = query;
    private readonly IPluginWriter _writer = writer;
    private readonly IPendingChangeService _changes = changes;
    private readonly ISchemaReflector _schemaReflector = schemaReflector;

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

        var headerGuardResult = CheckHeaderStageGuards(plugin, recordType!, fields, oldValues, session!);
        if (headerGuardResult != null) return headerGuardResult;

        var formRefs = ExtractFormKeyRefs(fields, schemasForValidation, recordType!);

        var distinctRefs = formRefs.Select(r => r.TargetFormKey).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var createGroupId = _changes.GetCreateGroupIdForAny(distinctRefs);

        var staged = _changes.Upsert(new PendingChangeUpsert(formKey, plugin, recordType!, fields, source, description, oldValues, formRefs, GroupId: createGroupId));
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
            if (!TryCollectVmadStructOp(path, op, vmadData, oldValues, formRefs))
                return new StageEditResult.RecordNotFound();
        }

        var staged = _changes.Upsert(new PendingChangeUpsert(
            formKey, plugin, recordType, fields, source, description,
            oldValues, formRefs, ChangeType: PendingChangeConstants.VmadStructOpChangeType));
        return new StageEditResult.Staged(staged);
    }

    private static string? GetOpName(JsonElement op) =>
        op.ValueKind == JsonValueKind.Object && op.TryGetProperty("op", out var opEl)
            ? opEl.GetString()
            : null;

    // Validates one struct-op payload and collects its old value and form refs.
    // False means the op is malformed or targets a missing script (surfaced as RecordNotFound).
    private static bool TryCollectVmadStructOp(
        string path, JsonElement op, VmadData? vmadData,
        Dictionary<string, JsonElement> oldValues, List<PendingFormRef> formRefs)
    {
        if (GetOpName(op) is not { } opName)
            return false;

        // Route by path shape: "VMAD\<ScriptName>" is a script-level op (add/remove script, set
        // script flags) — staged as-is with no value validation or old-value capture.
        if (VmadPath.TryParseScript(path, out _))
            return true;

        if (!VmadPath.TryParse(path, out var scriptName, out var propName))
            return false;

        // add_property targets an existing script — reject early if it's absent.
        if (opName == "add_property" &&
            vmadData?.Scripts.Any(s => string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase)) != true)
        {
            return false;
        }

        // Capture the property's current value (if any) for revert display.
        if (FindVmadProperty(vmadData, scriptName, propName) is { } prop)
            oldValues[path] = SerializeVmadOldValue(prop.Value);

        // Register form references carried in the op's value (Object / ArrayOfObject).
        if (op.TryGetProperty("value", out var value))
            ExtractVmadValueRefs(path, value, formRefs);

        return true;
    }

    // VMAD fields: check for Variable/ArrayOfVariable types which are read-only.
    // IsReadOnly returns false for all VMAD paths (it can't know the type without a DB lookup),
    // so we do the type check here using GetVmad.
    // The VMAD property types stageable as plain field edits; anything else (Variable,
    // ArrayOfVariable, Struct, ArrayOfStruct, ...) is read-only through this path.
    private static readonly HashSet<string> EditableVmadPropertyTypes = new(StringComparer.Ordinal)
    {
        "Bool", "Int", "Float", "String", "Object",
        "ArrayOfBool", "ArrayOfInt", "ArrayOfFloat", "ArrayOfString", "ArrayOfObject",
    };

    private static void CollectVmadReadOnlyFields(
        List<string> vmadFields, VmadData? vmadData, List<string> readOnlyFields)
    {
        foreach (var path in vmadFields)
        {
            if (!VmadPath.TryParse(path, out var scriptName, out var propName))
            {
                readOnlyFields.Add(path);
                continue;
            }
            if (FindVmadProperty(vmadData, scriptName, propName) is { } prop
                && !EditableVmadPropertyTypes.Contains(prop.Value.Type))
            {
                readOnlyFields.Add(path);
            }
        }
    }

    private static void CaptureVmadOldValues(
        List<string> vmadFields, VmadData? vmadData, Dictionary<string, JsonElement> oldValues)
    {
        foreach (var path in vmadFields)
        {
            if (!VmadPath.TryParse(path, out var scriptName, out var propName)
                || FindVmadProperty(vmadData, scriptName, propName) is not { } prop)
            {
                continue;
            }

            oldValues[path] = SerializeVmadOldValue(prop.Value);
        }
    }

    private static VmadNamedValue? FindVmadProperty(VmadData? vmadData, string scriptName, string propName) =>
        vmadData?.Scripts
            .FirstOrDefault(s => string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase))
            ?.Properties.FirstOrDefault(p => string.Equals(p.Name, propName, StringComparison.OrdinalIgnoreCase));

    private static JsonElement SerializeVmadOldValue(VmadPropertyValue v)
    {
        return (v.ListItems, v.Type) switch
        {
            ({ } items, "ArrayOfObject") => JsonSerializer.SerializeToElement(
                items.Select(i => new { formKey = (string?)i.Value, alias = i.Alias })),
            ({ } items, _) => JsonSerializer.SerializeToElement(items.Select(i => i.Value)),
            (null, "Object") => JsonSerializer.SerializeToElement(new { formKey = (string?)v.Value, alias = v.Alias }),
            _ => JsonSerializer.SerializeToElement(v.Value),
        };
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

        // Issue #86 invariant B: a staged copy must never leave the target referencing a FormKey
        // whose origin isn't declared in the target's masters — covers both the copied record's own
        // origin (its FormKey's ModKey — the copy keeps the same FormKey, so target needs that
        // origin as a master regardless of which plugin's override values were copied) and any
        // plugin referenced by a FormLink inside the copied content (already-extracted formRefs).
        var copyGroupId = StageMissingMasters(formKey, targetPlugin, formRefs, source);

        var staged = _changes.Upsert(new PendingChangeUpsert(formKey, targetPlugin, recordType!, fields, source, null, oldValues, formRefs,
            GroupId: copyGroupId, ParentCell: placement?.ParentCell, PlacementGroup: placement?.PlacementGroup));
        return new StageEditResult.Staged(staged);
    }

    // Issue #86 invariant B: computes which origin plugins the copied FormKey and its FormLink
    // content reference that the target doesn't already master (pending-aware — a still-unsaved
    // "Add Master" already counts), stages one masters-append pending change for them if any are
    // missing, and returns the group id to share with the copy's own pending change so both land in
    // the same change group (null when nothing was missing — a copy into an already-fully-mastered
    // target stays ungrouped, matching pre-#86 behavior).
    private Guid? StageMissingMasters(
        string copiedFormKey, string targetPlugin, IReadOnlyList<PendingFormRef> formRefs, string source)
    {
        var referencedPlugins = new List<string>();
        if (OriginPluginOf(copiedFormKey) is { } originPlugin) referencedPlugins.Add(originPlugin);
        foreach (var r in formRefs)
        {
            if (OriginPluginOf(r.TargetFormKey) is { } refPlugin) referencedPlugins.Add(refPlugin);
        }

        var currentMasters = GetEffectiveMasters(targetPlugin);
        var currentMastersSet = currentMasters.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var missingMasters = referencedPlugins
            .Where(p => !p.Equals(targetPlugin, StringComparison.OrdinalIgnoreCase) && !currentMastersSet.Contains(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (missingMasters.Count == 0) return null;

        var headerFormKey = Records.HeaderIndexer.FormKeyFor(targetPlugin);

        // A prior copy-to in this same unsaved session may already have grouped a masters-append
        // on this target header. Reuse that group instead of minting a new one: the pending-change
        // upsert's ON CONFLICT keeps the *first* group id a row was tagged with (DuckDbPendingChangeService
        // COALESCEs group_id), so generating a fresh id here every time would leave this call's own
        // copy tagged with a group the header's masters row never actually joined — breaking "same
        // change group" for the second of two sequential copy-tos into the same target.
        var groupId = _changes.GetGroupIdForRecord(headerFormKey, targetPlugin) ?? Guid.NewGuid();
        var newMasters = currentMasters.Concat(missingMasters).ToList();
        _changes.Upsert(new PendingChangeUpsert(
            headerFormKey, targetPlugin, Records.HeaderIndexer.TableName,
            new Dictionary<string, JsonElement> { [HeaderMastersField] = JsonSerializer.SerializeToElement(newMasters) },
            source, null,
            new Dictionary<string, JsonElement> { [HeaderMastersField] = JsonSerializer.SerializeToElement(currentMasters) },
            GroupId: groupId));
        return groupId;
    }

    // The plugin substring of a "FormID:Plugin" FormKey string; null when malformed (no colon, or
    // nothing after it). internal (not private) so it's directly unit-testable — every real caller
    // passes an already-validated FormKey (DB-resolved or FormLink-extracted), so the malformed
    // branch is defensive, but the parsing logic itself is simple enough to pin down directly.
    internal static string? OriginPluginOf(string formKey)
    {
        var colon = formKey.IndexOf(':');
        return colon >= 0 && colon < formKey.Length - 1 ? formKey[(colon + 1)..] : null;
    }

    // Issue #86: the target's masters as of right now — a still-pending "Add Master" (or a
    // preceding copy-to's auto-add within the same unsaved session) wins over the committed value,
    // same convention as CheckMasterEdit / IsPluginEslFlagged.
    private List<string> GetEffectiveMasters(string plugin)
    {
        var headerFormKey = Records.HeaderIndexer.FormKeyFor(plugin);
        var pending = _changes.GetPendingFields(headerFormKey, plugin);
        if (pending != null && pending.TryGetValue(HeaderMastersField, out var pendingJson))
            return ReadStringArray(pendingJson);

        var committed = _query.GetRecordForPlugin(headerFormKey, plugin)?.Fields
            .FirstOrDefault(fv => fv.Metadata.Name == HeaderMastersField);
        return committed != null ? ReadStringArray(JsonSerializer.SerializeToElement(committed.Value)) : [];
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

        // Issue #98 reverse guard: a create on an already ESL-flagged (or pending-flagged) plugin
        // must itself land in the ESL range — otherwise the invalidity would only surface at write.
        // The reservation counter is already spent at this point (its ID is simply skipped); undoing
        // the reservation isn't worth the added complexity for what should be a rare, recoverable case.
        if (CheckReverseEslGuard(plugin, reservedFormKey, session.GameRelease) is { } outOfRange)
            return new CreateRecordOutcome.EslIneligible(plugin, outOfRange);

        var groupId = Guid.NewGuid();
        _changes.Upsert(new PendingChangeUpsert(
            reservedFormKey, plugin, recordType,
            new Dictionary<string, JsonElement> { [PendingChangeConstants.CreateFieldPath] = JsonSerializer.SerializeToElement<object?>(null) },
            source, null,
            [],
            FormRefs: null,
            ChangeType: PendingChangeConstants.CreateChangeType,
            GroupId: groupId,
            ParentCell: parentCell,
            PlacementGroup: placementGroup));

        if (templateFields != null)
        {
            var templateRefs = ExtractFormKeyRefs(templateFields, schemas, recordType);
            _changes.Upsert(new PendingChangeUpsert(
                reservedFormKey, plugin, recordType,
                templateFields, source, null,
                [],
                templateRefs,
                ChangeType: PendingChangeConstants.FieldEditChangeType,
                GroupId: groupId));
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

        var (blocked, toNullify) = PartitionInboundReferences(targets, targetFormKeys, immutablePlugins);

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

        AddNullificationMembers(members, toNullify, source);

        var group = _changes.StageGroup("delete", null, members);
        return new DeleteRecordsResult.Staged(group);
    }

    private (List<BlockedReference> Blocked, List<(string SourceFormKey, string SourcePlugin, string FieldPath, string RecordType)> ToNullify)
        PartitionInboundReferences(
            IReadOnlyList<(string FormKey, string Plugin)> targets,
            HashSet<string> targetFormKeys,
            HashSet<string> immutablePlugins)
    {
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

        return (blocked, toNullify);
    }

    // Group by (record, field) first: two deleted targets can each be referenced by a
    // different element of the *same* array field on the same source record, and staging
    // one GroupMember per reference would have the second overwrite the first's removal
    // (StageGroup upserts on (form_key, plugin, field_path)).
    private void AddNullificationMembers(
        List<GroupMember> members,
        List<(string SourceFormKey, string SourcePlugin, string FieldPath, string RecordType)> toNullify,
        string source)
    {
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

        // Issue #98 reverse guard: a renumber onto an already ESL-flagged (or pending-flagged)
        // plugin must land its target FormID in the ESL range — checked early, before the
        // (expensive) reference scan below, since there's nothing to gain from doing that work
        // first.
        if (CheckReverseEslGuard(plugin, newFormKey, session.GameRelease) is { } outOfRange)
            return new RenumberResult.EslIneligible(plugin, outOfRange);

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

        var members = new List<GroupMember>
        {
            // The renumber change for the record itself
            new(
                formKey, plugin, recordType,
                PendingChangeConstants.RenumberChangeType,
                PendingChangeConstants.RenumberFieldPath,
                JsonSerializer.SerializeToElement(formKey),
                JsonSerializer.SerializeToElement(newFormKey),
                source),
        };

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

    [GeneratedRegex(@"\[(\d+)\]")]
    private static partial Regex BracketIndex();

    private static int? ParseArrayIndex(string fieldPath)
    {
        var m = BracketIndex().Match(fieldPath);
        return m.Success ? int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) : null;
    }

    private static JsonElement RemoveArrayElements(JsonElement array, IReadOnlyList<int> indices)
    {
        var items = array.EnumerateArray().ToList();
        foreach (var index in indices.Distinct().OrderByDescending(i => i))
            items.RemoveAt(index);
        return JsonSerializer.SerializeToElement(items);
    }

    private const string HeaderFlagsField = "flags";

    // Combines the two header-only stage-time guards (ESL-eligibility, issue #98; masters
    // validation, issue #86) behind one call so StageEdit only branches on a single early-out
    // here, not two.
    private StageEditResult? CheckHeaderStageGuards(
        string plugin, string recordType, Dictionary<string, JsonElement> fields,
        Dictionary<string, JsonElement> oldValues, IGameSession session)
    {
        StageEditResult? eslResult = CheckEslEligibility(plugin, recordType, fields, oldValues, session.GameRelease);
        return eslResult ?? CheckMasterEdit(plugin, recordType, fields, session);
    }

    // Stage-time ESL-eligibility guard (ADR-0020 style): only when a header edit turns the ESL bit
    // ON (off→on transition) do we require every native FormID to be in the ESL range. Toggling ESM,
    // clearing ESL, or editing on a plugin that's already ESL are never validated here.
    private StageEditResult.EslIneligible? CheckEslEligibility(
        string plugin, string recordType, Dictionary<string, JsonElement> fields,
        Dictionary<string, JsonElement> oldValues, GameRelease release)
    {
        if (recordType != Records.HeaderIndexer.TableName) return null;
        if (!fields.TryGetValue(HeaderFlagsField, out var newFlagsJson)) return null;
        if (!TryGetEslBit(release, out var eslBit)) return null;

        var newFlags = ReadFlagsLong(newFlagsJson);
        var oldFlags = oldValues.TryGetValue(HeaderFlagsField, out var oldJson) ? ReadFlagsLong(oldJson) : 0L;
        var turningEslOn = (newFlags & eslBit) != 0 && (oldFlags & eslBit) == 0;
        if (!turningEslOn) return null;

        var outOfRange = EslEligibility.OutOfRangeFormKeys(GetEffectiveNativeFormKeys(plugin));
        return outOfRange.Count == 0 ? null : new StageEditResult.EslIneligible(plugin, outOfRange);
    }

    // Single source of truth lives on HeaderIndexer (shared with SchemaReflector's column
    // definition and PluginWriter's write-time override) — aliased here for call-site brevity.
    private const string HeaderMastersField = Records.HeaderIndexer.MastersFieldName;

    // Issue #86 stage-time guard for the header's masters field: a validated, add-only
    // plugin-reference array. First rejects any entry naming a plugin absent from the session,
    // since a master resolving to no file makes the plugin unloadable. Then rejects any edit that
    // is not a pure append onto GetEffectiveMasters' baseline (the same helper the copy-to
    // auto-add-master path uses below), so reordering, removing, or duplicating an existing master
    // is refused. Sort, clean, and remove operations remain deferred to scripts per AC5.
    private StageEditResult.InvalidReferences? CheckMasterEdit(
        string plugin, string recordType, Dictionary<string, JsonElement> fields, IGameSession session)
    {
        if (recordType != Records.HeaderIndexer.TableName) return null;
        if (!fields.TryGetValue(HeaderMastersField, out var newMastersJson)) return null;

        // The PATCH endpoint hands this JSON straight through from the request body, so it's not
        // guaranteed to be an array (a malformed caller could send a string or number) — reject that
        // outright rather than silently coercing it to an empty list (ADR-0026: never stage an edit
        // that looks accepted but does nothing).
        if (newMastersJson.ValueKind != JsonValueKind.Array)
        {
            return new StageEditResult.InvalidReferences([
                new ReferenceValidationError(HeaderMastersField, newMastersJson.GetRawText(), "not_append_only", [])
            ]);
        }

        var proposed = ReadStringArray(newMastersJson);

        var loadedPlugins = session.Plugins.Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var notLoaded = proposed.Where(m => !loadedPlugins.Contains(m)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (notLoaded.Count > 0)
        {
            return new StageEditResult.InvalidReferences(
                notLoaded.ConvertAll(m => new ReferenceValidationError(HeaderMastersField, m, "not_in_session", [])));
        }

        var effectiveCurrent = GetEffectiveMasters(plugin);
        return IsPureAppend(effectiveCurrent, proposed)
            ? null
            : new StageEditResult.InvalidReferences([
                new ReferenceValidationError(HeaderMastersField, JsonSerializer.Serialize(proposed), "not_append_only", [])
            ]);
    }

    private static List<string> ReadStringArray(JsonElement el) =>
        el.ValueKind == JsonValueKind.Array
            ? el.EnumerateArray().Select(e => e.GetString() ?? "").ToList()
            : [];

    // True when `proposed` is exactly `current` as an ordered prefix, plus one or more newly
    // appended entries that don't duplicate anything already present.
    private static bool IsPureAppend(List<string> current, List<string> proposed)
    {
        if (proposed.Count < current.Count) return false;
        for (var i = 0; i < current.Count; i++)
        {
            if (!string.Equals(proposed[i], current[i], StringComparison.OrdinalIgnoreCase)) return false;
        }

        var appended = proposed.Skip(current.Count).ToList();
        return appended.Distinct(StringComparer.OrdinalIgnoreCase).Count() == appended.Count
            && !appended.Any(a => current.Contains(a, StringComparer.OrdinalIgnoreCase));
    }

    // Issue #98: the committed record index alone misses pending creates/renumbers, so a plugin
    // could be flagged ESL while a not-yet-saved change would make it invalid. Unions the committed
    // native FormKeys with pending create/renumber targets, and drops any committed FormKey a
    // pending renumber has moved away from (else a renumber that *fixes* an out-of-range record
    // would leave the stale high FormID counted against eligibility).
    private IReadOnlyList<string> GetEffectiveNativeFormKeys(string plugin)
    {
        var committed = _query.GetNativeFormKeys(plugin);
        var (added, removed) = _changes.GetPendingNativeFormKeyChanges(plugin);
        if (added.Count == 0 && removed.Count == 0) return committed;

        var removedSet = removed.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return committed.Where(fk => !removedSet.Contains(fk)).Concat(added).ToList();
    }

    // Issue #98 reverse guard, shared by CreateRecordCore and Renumber: null when `candidateFormKey`
    // is fine (either the plugin isn't ESL, or the FormID is in range); otherwise the single-element
    // out-of-range list their EslIneligible outcomes expect.
    private IReadOnlyList<string>? CheckReverseEslGuard(string plugin, string candidateFormKey, GameRelease release)
    {
        if (!IsPluginEslFlagged(plugin, release)) return null;
        var outOfRange = EslEligibility.OutOfRangeFormKeys([candidateFormKey]);
        return outOfRange.Count == 0 ? null : outOfRange;
    }

    // Issue #98 reverse guard: is `plugin` ESL right now, considering a not-yet-saved header edit
    // that would flip the flag? Pending wins over committed (matches the read-overlay convention
    // elsewhere) — a staged-but-unsaved ESL toggle already governs eligibility for new creates/
    // renumbers, same as it would once written.
    private bool IsPluginEslFlagged(string plugin, GameRelease release)
    {
        if (!TryGetEslBit(release, out var eslBit)) return false;

        var headerFormKey = Records.HeaderIndexer.FormKeyFor(plugin);

        var pending = _changes.GetPendingFields(headerFormKey, plugin);
        if (pending != null && pending.TryGetValue(HeaderFlagsField, out var pendingFlags))
            return (ReadFlagsLong(pendingFlags) & eslBit) != 0;

        var committedFlags = _query.GetRecordForPlugin(headerFormKey, plugin)?.Fields
            .FirstOrDefault(fv => fv.Metadata.Name == HeaderFlagsField);
        return committedFlags != null
            && (ReadFlagsLong(JsonSerializer.SerializeToElement(committedFlags.Value)) & eslBit) != 0;
    }

    // Shared by CheckEslEligibility and IsPluginEslFlagged: a game whose header schema carries no
    // ESL/light-master flag bit (not all Mutagen-supported games do) never validates ESL eligibility.
    private bool TryGetEslBit(GameRelease release, out long eslBit)
    {
        if (_schemaReflector.GetSchemas(release).GetValueOrDefault(Records.HeaderIndexer.TableName)
                is { EslFlagValue: { } bit })
        {
            eslBit = bit;
            return true;
        }
        eslBit = 0;
        return false;
    }

    // Bitmask flags travel as decimal strings (to survive JSON above 2^53) from the frontend, but
    // captured old values are serialized numbers; accept either, and treat null as no flags set.
    private static long ReadFlagsLong(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => long.Parse(v.GetString()!, System.Globalization.CultureInfo.InvariantCulture),
        JsonValueKind.Number => v.GetInt64(),
        _ => 0L,
    };

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
            return committed ?? _changes.GetPendingCreateRecordType(fk);
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
            {
                ExtractVmadValueRefs(fieldPath, newValue, result);
            }
            else if (colsByName.TryGetValue(fieldPath, out var col))
            {
                FormRefPathBuilder.Walk(col, _ => (object?)newValue, (path, fk) =>
                                result.Add(new PendingFormRef(fieldPath, path, fk)));
            }
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
            {
                if (el.ValueKind == JsonValueKind.Object &&
                    el.TryGetProperty("formKey", out var elFkEl) &&
                    elFkEl.GetString() is string elFk)
                {
                    into.Add(new PendingFormRef(fieldPath, fieldPath, elFk));
                }
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
        (StageEditResult? earlyOut, IGameSession? session, string? recordType) result = recordType == null
            ? (new StageEditResult.RecordNotFound(), null, null)
            : (null, session, recordType);
        return result;
    }
}
