using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

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

        if (PendingLifecycleChangeType(formKey, plugin) is { } blockingType)
            return new StageEditResult.RecordPendingDeleteOrRenumber(blockingType);

        if (changeType == PendingChangeConstants.VmadStructOpChangeType)
            return StageVmadStructOps(formKey, plugin, recordType!, fields, source, description);

        var readOnlyFields = fields.Keys
            .Where(f => _writer.IsReadOnly(session!.GameRelease, recordType!, f))
            .ToList();

        var vmadFields = fields.Keys.Where(VmadPath.IsVmadPath).ToList();
        VmadData? vmadData = vmadFields.Count > 0 ? _query.GetVmad(formKey, plugin, ResolveOrigin(plugin)) : null;
        CollectVmadReadOnlyFields(vmadFields, vmadData, readOnlyFields);

        var conditionFields = fields.Keys.Where(ConditionPath.IsConditionPath).ToList();
        IReadOnlyList<ConditionOwner>? conditionOwners =
            conditionFields.Count > 0 ? _query.GetConditions(formKey, plugin, ResolveOrigin(plugin)) : null;

        if (readOnlyFields.Count > 0)
            return new StageEditResult.ReadOnlyFields(readOnlyFields);

        var schemasForValidation = _schemaReflector.GetSchemas(session!.GameRelease);
        var referenceErrors = ValidateReferences(fields, schemasForValidation, recordType!);
        if (referenceErrors.Count > 0)
            return new StageEditResult.InvalidReferences(referenceErrors);

        var currentRecord = _query.GetRecordForPlugin(formKey, plugin, ResolveOrigin(plugin));
        var oldValues = new Dictionary<string, JsonElement>();
        if (currentRecord != null)
        {
            foreach (var fv in currentRecord.Fields.Where(fv => fields.ContainsKey(fv.Metadata.Name)))
                oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
        }

        CaptureVmadOldValues(vmadFields, vmadData, oldValues);
        CaptureConditionOldValues(conditionFields, conditionOwners, oldValues);

        var headerGuardResult = CheckHeaderStageGuards(plugin, recordType!, fields, oldValues, session!);
        if (headerGuardResult != null) return headerGuardResult;

        var formRefs = ExtractFormKeyRefs(fields, schemasForValidation, recordType!, session!.GameRelease);

        // #153 Q3: a whole-list restage (add/remove/move) supersedes any already-staged per-field
        // CTDA\<fieldPath>\N\... edits on the same owning field — their indices are no longer
        // trustworthy once the list has been reordered/added-to/removed-from (ADR-0019). Cleared
        // before the upsert below so the two can never both land as separate pending rows that a
        // save would apply twice.
        ClearSupersededConditionListFields(formKey, plugin, fields, schemasForValidation, recordType!, session!.GameRelease);

        // #183 AC4: restaging the *enclosing* array itself (e.g. "Effects", not a nested list's own
        // "Effects[2].Conditions") invalidates every staged condition row keyed under it — the
        // enclosing indices no longer hold once that array has been reordered/added-to/removed-from.
        ClearInvalidatedNestedConditionFields(formKey, plugin, fields, schemasForValidation, recordType!, session!.GameRelease);

        // No group is assigned here (#134): an edit that references a pending-created record is
        // grouped with that create by the edge rules (ADR-0028), not by a group id stamped at stage
        // time. The pending_form_references written by this upsert are the edge the rules read.
        var staged = _changes.Upsert(new PendingChangeUpsert(formKey, plugin, recordType!, fields, source, description, oldValues,
            Origin: ResolveOrigin(plugin), FormRefs: formRefs, ChangeType: PendingChangeConstants.FieldEditChangeType,
            ParentCell: null, PlacementGroup: null));
        return new StageEditResult.Staged(staged);
    }

    private void ClearSupersededConditionListFields(
        string formKey, string plugin, Dictionary<string, JsonElement> fields,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, string recordType, GameRelease release)
    {
        if (!schemas.TryGetValue(recordType, out var schema)) return;
        if (ConditionCodecRegistry.For(release.ToCategory()) is not { } codec) return;

        // #154/#183: matches on any of the record's condition-owning fields — a flat one (bare
        // field name, e.g. "Conditions"/"UnusedConditions") or a nested list's own composed indexed
        // path (e.g. "Effects[0].Conditions") — so a restage clears only its own stale
        // CTDA\<field>\... rows: never a sibling flat field's, and never a sibling index's on the
        // same enclosing array (the prefix includes this field's own index).
        foreach (var field in fields.Keys.Where(f => IsRestageableConditionListField(f, schema.RecordType, codec)))
            _changes.RemoveFieldsWithPrefix(formKey, plugin, $@"{ConditionPath.Prefix}{field}\", ResolveOrigin(plugin));
    }

    private static bool IsRestageableConditionListField(string field, Type recordType, IConditionCodec codec) =>
        codec.IsConditionListField(recordType, field)
        || codec.IsNestedConditionListField(recordType, field);

    // #183/#184 AC4: restaging any *ancestor* array invalidates every staged condition row keyed
    // beneath it — both a per-field CTDA\ nested edit and a nested list's own restage — since the
    // enclosing indices no longer hold once that array has been reordered/added-to/removed-from
    // (ADR-0019). "Ancestor" generalizes to N levels for free here: restaging the outer array
    // ("Effects") invalidates everything nested under it at any depth, and restaging a *middle*
    // level's own list ("Effects[2].Conditions" — itself a bare, bracketed, non-CTDA field, e.g. a
    // Perk effect's PerkCondition list) invalidates only what's staged deeper than that exact path
    // ("Effects[2].Conditions[*].Conditions...") — never a sibling middle-level group at a different
    // outer index ("Effects[5].Conditions..."). That fan-out/containment is exactly what a SQL LIKE
    // prefix match already gives for free (RemoveFieldsWithPrefix): "Effects[" matches both depths
    // beneath it, "Effects[2].Conditions[" matches only what's beneath that specific index. So the
    // loop runs for *every* bare, non-condition-path field being staged — bracketed (a nested list's
    // own restage) or not (a top-level array's restage) — with no check of whether the field is
    // actually an array, or actually houses nested conditions further down, since the prefix match
    // is a no-op unless matching rows already exist. Restaging a field's own exact path is never
    // mistaken for restaging something beneath it: the prefix always has a trailing '[', which the
    // field's own bare string, lacking one, can never start with.
    //
    // The one schema lookup that *is* required: an unbracketed field name is the wire/column name
    // (SchemaReflector.ToSnakeCase, e.g. "menu_buttons" — see SchemaReflectorTests' "aggro_radius_
    // behavior_enabled"), while a nested condition's composed path is keyed by the CLR PropertyName
    // instead (Fallout4ConditionCodec.ExtractNested's prop.Name, e.g. "MenuButtons[2].Conditions").
    // The two conventions share no literal prefix at all for a multi-word property without this
    // translation (ColumnSpec.PropertyName carries the original CLR name for exactly this reason) —
    // unlike single-word names such as "Effects"/"effects", which coincidentally differ only in
    // case and would falsely appear to work without it. A bracketed field is already the CLR-composed
    // form (nothing in RecordColumns ever has a bracketed Name), so the lookup misses and `?? field`
    // correctly falls through to the identity — no separate branch needed for the two shapes.
    private void ClearInvalidatedNestedConditionFields(
        string formKey, string plugin, Dictionary<string, JsonElement> fields,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, string recordType, GameRelease release)
    {
        if (ConditionCodecRegistry.For(release.ToCategory()) == null) return;
        if (!schemas.TryGetValue(recordType, out var schema)) return;

        foreach (var field in fields.Keys.Where(f => !ConditionPath.IsConditionPath(f)))
        {
            var arrayProp = schema.RecordColumns.FirstOrDefault(c => c.Name == field)?.PropertyName ?? field;
            _changes.RemoveFieldsWithPrefix(formKey, plugin, $"{arrayProp}[", ResolveOrigin(plugin));
            _changes.RemoveFieldsWithPrefix(formKey, plugin, $@"{ConditionPath.Prefix}{arrayProp}[", ResolveOrigin(plugin));
        }
    }

    // Phase 13.8 structural ops: each field value is an op payload { op, ... } rather than a plain
    // value, so the normal scalar validation/ref-extraction is bypassed in favour of op-aware handling.
    private StageEditResult StageVmadStructOps(
        string formKey, string plugin, string recordType,
        Dictionary<string, JsonElement> fields, string source, string? description)
    {
        var vmadData = _query.GetVmad(formKey, plugin, ResolveOrigin(plugin));
        var oldValues = new Dictionary<string, JsonElement>();
        var formRefs = new List<PendingFormRef>();

        foreach (var (path, op) in fields)
        {
            if (!TryCollectVmadStructOp(path, op, vmadData, oldValues, formRefs))
                return new StageEditResult.RecordNotFound();
        }

        var staged = _changes.Upsert(new PendingChangeUpsert(
            formKey, plugin, recordType, fields, source, description, oldValues,
            Origin: ResolveOrigin(plugin), FormRefs: formRefs, ChangeType: PendingChangeConstants.VmadStructOpChangeType,
            ParentCell: null, PlacementGroup: null));
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
    // Which types are stageable as plain field edits is the codec's editability policy.
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
                && !VmadCodec.IsEditable(prop.Value.Type))
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

    private static void CaptureConditionOldValues(
        List<string> conditionFields, IReadOnlyList<ConditionOwner>? owners, Dictionary<string, JsonElement> oldValues)
    {
        foreach (var path in conditionFields)
        {
            if (!ConditionPath.TryParse(path, out var fieldPath, out var index, out var subField))
                continue;

            var owner = owners?.FirstOrDefault(o => o.FieldPath == fieldPath);
            if (owner == null || index < 0 || index >= owner.Conditions.Count)
                continue;

            oldValues[path] = ConditionOldValue(owner.Conditions[index], subField);
        }
    }

    // The neutral ParsedCondition already has every sub-field this wire path can address; this just
    // picks the one subField names and serializes it the same shape the matching edit payload uses
    // (ConditionSection's field keys / Fallout4ConditionCodec.ApplyFieldValue's subField switch).
    private static JsonElement ConditionOldValue(ParsedCondition condition, string subField)
    {
        if (subField == "Function") return JsonSerializer.SerializeToElement(condition.Function);
        if (subField == "Operator") return JsonSerializer.SerializeToElement(condition.Operator.ToString());
        if (subField == "UseGlobal") return JsonSerializer.SerializeToElement(condition.UseGlobal);
        if (subField == "RunOn")
        {
            return JsonSerializer.SerializeToElement(
                new { target = condition.RunOnTarget, reference = condition.RunOnReference });
        }
        if (subField == "Comparison")
        {
            return condition.UseGlobal
                ? JsonSerializer.SerializeToElement(condition.ComparisonGlobal)
                : JsonSerializer.SerializeToElement(condition.ComparisonFloat);
        }
        if (ConditionPath.TryParseParameterIndex(subField, out var paramIndex)
            && paramIndex < condition.Parameters.Count)
        {
            var p = condition.Parameters[paramIndex];
            return p.Category switch
            {
                ConditionParamCategory.Form => JsonSerializer.SerializeToElement(p.FormKey),
                ConditionParamCategory.Text => JsonSerializer.SerializeToElement(p.Text),
                _ => JsonSerializer.SerializeToElement(p.Number),
            };
        }
        return PendingChangeConstants.NullElement;
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

    public StageEditResult CopyRecordTo(
        string formKey, string targetPlugin, string source, string? sourcePlugin = null, string? sourceOrigin = null)
    {
        var (earlyOut, session, recordType) = ValidateEditContext(formKey, targetPlugin);
        if (earlyOut != null) return earlyOut;

        if (PendingLifecycleChangeType(formKey, targetPlugin) is { } blockingType)
            return new StageEditResult.RecordPendingDeleteOrRenumber(blockingType);

        // Issue #202: an explicit sourcePlugin copies that plugin's own version of the record (the
        // column-header menu's right-clicked column) rather than the overall winner.
        // #34 / ADR-0036: with sourceOrigin the caller names which *copy* of that filename it
        // right-clicked, which is the only way to tell two loaded copies apart. Without it the
        // origin is resolved from the filename — the pre-#34 behaviour, and still correct for the
        // overwhelming case of a filename naming exactly one loaded copy.
        var sourceRecord = sourcePlugin != null
            ? _query.GetRecordForPlugin(formKey, sourcePlugin, sourceOrigin ?? ResolveOrigin(sourcePlugin))
            : _query.GetRecord(formKey);
        if (sourceRecord == null) return new StageEditResult.RecordNotFound();

        var fields = sourceRecord.Fields.ToDictionary(
            fv => fv.Metadata.Name,
            fv => JsonSerializer.SerializeToElement(fv.Value));

        var currentTarget = _query.GetRecordForPlugin(formKey, targetPlugin, ResolveOrigin(targetPlugin));
        var oldValues = new Dictionary<string, JsonElement>();
        if (currentTarget != null)
        {
            foreach (var fv in currentTarget.Fields)
                oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
        }

        var placement = _query.GetPlacement(formKey, sourceRecord.Plugin, sourceRecord.Origin);

        var schemas = _schemaReflector.GetSchemas(session!.GameRelease);
        var formRefs = ExtractFormKeyRefs(fields, schemas, recordType!, session!.GameRelease);

        // Issue #86 invariant B: a staged copy must never leave the target referencing a FormKey
        // whose origin isn't declared in the target's masters — covers both the copied record's own
        // origin (its FormKey's ModKey — the copy keeps the same FormKey, so target needs that
        // origin as a master regardless of which plugin's override values were copied) and any
        // plugin referenced by a FormLink inside the copied content (already-extracted formRefs).
        StageMissingMasters(formKey, targetPlugin, formRefs, source);

        var staged = _changes.Upsert(new PendingChangeUpsert(formKey, targetPlugin, recordType!, fields, source, null, oldValues,
            Origin: ResolveOrigin(targetPlugin), FormRefs: formRefs, ChangeType: PendingChangeConstants.FieldEditChangeType,
            ParentCell: placement?.ParentCell, PlacementGroup: placement?.PlacementGroup));
        return new StageEditResult.Staged(staged);
    }

    // Issue #86 invariant B: computes which origin plugins the copied FormKey and its FormLink
    // content reference that the target doesn't already master (pending-aware — a still-unsaved
    // "Add Master" already counts), and stages one masters-append pending change for them if any are
    // missing. No group is assigned (#134): the copy and this masters-add are grouped by edge rule 3
    // (a record reachable only via a master the change adds), and two sequential copy-tos into the
    // same target land in one group because the upsert's ON CONFLICT collapses onto the one header
    // row they both depend on — the edge rules rediscover the grouping the old group id declared.
    private void StageMissingMasters(
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

        if (missingMasters.Count == 0) return;

        var headerFormKey = Records.HeaderIndexer.FormKeyFor(targetPlugin);
        var newMasters = currentMasters.Concat(missingMasters).ToList();
        _changes.Upsert(new PendingChangeUpsert(
            headerFormKey, targetPlugin, Records.HeaderIndexer.TableName,
            new Dictionary<string, JsonElement> { [HeaderMastersField] = JsonSerializer.SerializeToElement(newMasters) },
            source, null,
            new Dictionary<string, JsonElement> { [HeaderMastersField] = JsonSerializer.SerializeToElement(currentMasters) },
            Origin: ResolveOrigin(targetPlugin), FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType,
            ParentCell: null, PlacementGroup: null));
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

    // The change_type of a pending delete or renumber on this record, or null. Editing, copying onto,
    // or re-deleting a record that is about to cease to exist or change identity is incoherent — this
    // is the semantic reason those operations block, replacing the old "record has any group" guard
    // (#134): every change has a group now (ADR-0028), so group membership no longer distinguishes.
    private string? PendingLifecycleChangeType(string formKey, string plugin) =>
        _changes.GetChanges(plugin: plugin, formKey: formKey, origin: ResolveOrigin(plugin))
            .FirstOrDefault(c => c.ChangeType is PendingChangeConstants.DeleteChangeType
                                            or PendingChangeConstants.RenumberChangeType)
            ?.ChangeType;

    // Issue #86: the target's masters as of right now — a still-pending copy-to auto-add-master
    // (within the same unsaved session) wins over the committed value, same pending-over-committed
    // convention as IsPluginEslFlagged. #335/ADR-0038: only StageMissingMasters below still calls
    // this — CheckMasterEdit no longer needs a baseline, since it rejects every direct edit
    // outright regardless of content.
    private List<string> GetEffectiveMasters(string plugin)
    {
        var headerFormKey = Records.HeaderIndexer.FormKeyFor(plugin);
        var pending = _changes.GetPendingFields(headerFormKey, plugin, ResolveOrigin(plugin));
        if (pending != null && pending.TryGetValue(HeaderMastersField, out var pendingJson))
            return ReadStringArray(pendingJson);

        var committed = _query.GetRecordForPlugin(headerFormKey, plugin, ResolveOrigin(plugin))?.Fields
            .FirstOrDefault(fv => fv.Metadata.Name == HeaderMastersField);
        return committed != null ? ReadStringArray(JsonSerializer.SerializeToElement(committed.Value)) : [];
    }

    public CreateRecordOutcome CreateRecord(
        string plugin, string? recordType, string? templateFormKey, string source,
        string? templateSourcePlugin = null, string? templateSourceOrigin = null) =>
        CreateRecordCore(plugin, recordType, templateFormKey, source, parentCell: null, placementGroup: null,
            templateSourcePlugin, templateSourceOrigin);

    public CreateRecordOutcome CreatePlacedRecord(
        string plugin, string recordType, string parentCell, string placementGroup,
        string? templateFormKey, string source) =>
        CreateRecordCore(plugin, recordType, templateFormKey, source, parentCell, placementGroup,
            templateSourcePlugin: null, templateSourceOrigin: null);

    private CreateRecordOutcome CreateRecordCore(
        string plugin, string? recordType, string? templateFormKey, string source,
        string? parentCell, string? placementGroup,
        string? templateSourcePlugin, string? templateSourceOrigin)
    {
        var session = _sessionManager.Session
            ?? throw new InvalidOperationException("No session loaded.");

        // #281: a caller with a template may omit recordType — the tree's record row knows only
        // its FormKey — so derive it from the template record itself.
        recordType ??= (templateFormKey != null ? _query.GetRecordType(templateFormKey) : null)
            ?? throw new ArgumentException("recordType is required when no template is given.", nameof(recordType));

        var schemas = _schemaReflector.GetSchemas(session.GameRelease);
        if (!schemas.ContainsKey(recordType))
            throw new ArgumentException($"Unknown record type '{recordType}'.", nameof(recordType));

        Dictionary<string, JsonElement>? templateFields = null;
        if (templateFormKey != null)
        {
            // #281: an explicit templateSourcePlugin reads that copy's own version of the template
            // record — same contract as CopyRecordTo's sourcePlugin/sourceOrigin above.
            var template = templateSourcePlugin != null
                ? _query.GetRecordForPlugin(templateFormKey, templateSourcePlugin, templateSourceOrigin ?? ResolveOrigin(templateSourcePlugin))
                : _query.GetRecord(templateFormKey);
            if (template == null)
                throw new ArgumentException($"Template record '{templateFormKey}' not found.", nameof(templateFormKey));

            templateFields = template.Fields
                .Where(fv => !_writer.IsReadOnly(session.GameRelease, recordType, fv.Metadata.Name))
                .ToDictionary(fv => fv.Metadata.Name, fv => JsonSerializer.SerializeToElement(fv.Value));

            var referenceErrors = ValidateReferences(templateFields, schemas, recordType);
            if (referenceErrors.Count > 0)
                return new CreateRecordOutcome.InvalidReferences(referenceErrors);

            // #281: a placed template's copy lands under the template's own cell and group (xEdit
            // keeps a copied ref in its cell; an unparented REFR is an orphan) — unless the caller
            // stated a placement explicitly (CreatePlacedRecord).
            if (parentCell == null)
            {
                var placement = _query.GetPlacement(templateFormKey, template.Plugin, template.Origin);
                parentCell = placement?.ParentCell;
                placementGroup = placement?.PlacementGroup;
            }
        }

        var reservedFormKey = _sessionManager.ReserveFormKey(plugin);

        // Issue #98 reverse guard: a create on an already ESL-flagged (or pending-flagged) plugin
        // must itself land in the ESL range — otherwise the invalidity would only surface at write.
        // The reservation counter is already spent at this point (its ID is simply skipped); undoing
        // the reservation isn't worth the added complexity for what should be a rare, recoverable case.
        if (CheckReverseEslGuard(plugin, reservedFormKey, session.GameRelease) is { } outOfRange)
            return new CreateRecordOutcome.EslIneligible(plugin, outOfRange);

        var created = _changes.Upsert(new PendingChangeUpsert(
            reservedFormKey, plugin, recordType,
            new Dictionary<string, JsonElement> { [PendingChangeConstants.CreateFieldPath] = JsonSerializer.SerializeToElement<object?>(null) },
            source, null,
            [],
            FormRefs: null,
            ChangeType: PendingChangeConstants.CreateChangeType,
            ParentCell: parentCell,
            PlacementGroup: placementGroup,
            Origin: ResolveOrigin(plugin)));

        if (templateFields != null)
        {
            var templateRefs = ExtractFormKeyRefs(templateFields, schemas, recordType, session.GameRelease);
            _changes.Upsert(new PendingChangeUpsert(
                reservedFormKey, plugin, recordType,
                templateFields, source, null,
                [],
                Origin: ResolveOrigin(plugin),
                FormRefs: templateRefs,
                ChangeType: PendingChangeConstants.FieldEditChangeType,
                ParentCell: null, PlacementGroup: null));
        }

        // The id callers get back names the $create change itself. Groups have no identity of their
        // own, so save and revert take a member change id and act on its whole component (ADR-0028).
        // The template fields staged above join that component by edge rule 2 (an edit on a record a
        // pending $create brings into existence), not by any label.
        return new CreateRecordOutcome.Success(reservedFormKey, created[0].Id);
    }

    public DeleteRecordsResult DeleteRecords(IReadOnlyList<(string FormKey, string Plugin)> targets, string source)
    {
        var session = _sessionManager.Session;
        if (session == null) return new DeleteRecordsResult.NoSession();

        if (FindImmutablePluginTarget(targets, session) is { } immutablePlugin)
            return new DeleteRecordsResult.PluginImmutable(immutablePlugin);

        // Block targets already pending a delete or renumber (see TargetPendingDeleteOrRenumber).
        var blockedKeys = targets
            .Where(t => PendingLifecycleChangeType(t.FormKey, t.Plugin) != null)
            .Select(t => t.FormKey)
            .ToList();
        if (blockedKeys.Count > 0)
            return new DeleteRecordsResult.TargetPendingDeleteOrRenumber(blockedKeys);

        // A pending-create target has no on-disk existence for a $delete to act on (#143): deleting it
        // reverts the create's whole dependency component instead of staging a $delete. Reference
        // scanning below only applies to the rest — nothing committed can reference a FormKey that
        // doesn't exist on disk yet, so a pending-create target can never be BlockedByReferences.
        var createTargets = targets
            .Where(t => _changes.GetPendingCreateRecordType(t.FormKey) != null)
            .ToList();
        var plainTargets = targets.Except(createTargets).ToList();

        // Check plain-target reference blocking *before* reverting any pending-create: reverting is a
        // mutation, so it must not fire on a call that's about to fail with BlockedByReferences —
        // otherwise a create the user never asked to touch would vanish behind a "failed" response.
        var (blocked, toNullify) = PartitionInboundReferences(plainTargets, session);
        if (blocked.Count > 0)
            return new DeleteRecordsResult.BlockedByReferences(blocked);

        var revertedFormKeys = RevertPendingCreateTargets(createTargets);

        return plainTargets.Count == 0
            ? new DeleteRecordsResult.Reverted(revertedFormKeys)
            : StagePlainDeletes(plainTargets, source, toNullify, revertedFormKeys);
    }

    // The plugin name of the first target that isn't a legitimate write target, or null. #306: no
    // load-order member of the name refuses here too, same as an immutable one — proceeding would
    // only stage a delete that could later fail at save time instead of being refused up front.
    private static string? FindImmutablePluginTarget(
        IReadOnlyList<(string FormKey, string Plugin)> targets, IGameSession session) =>
        targets
            .Select(t => t.Plugin)
            .FirstOrDefault(plugin => session.LoadOrderPlugin(plugin) is not { IsImmutable: false });

    // Reverts each pending-create target's whole dependency component (ADR-0028) via the same
    // RevertGroup path the revert-group endpoint uses — no new cascade logic. Returns the FormKeys
    // reverted, in the order given.
    private List<string> RevertPendingCreateTargets(IReadOnlyList<(string FormKey, string Plugin)> createTargets)
    {
        var reverted = new List<string>();
        foreach (var (formKey, plugin) in createTargets)
        {
            // #296 review: scoped to the target's own resolved origin — GetChanges' origin filter
            // was silently unused here, so two same-filename origins' pending creates (once #34
            // lets both exist in a session) would collide on formKey alone and this could revert
            // the wrong origin's create.
            var createChangeId = _changes.GetChanges(plugin: plugin, formKey: formKey, origin: ResolveOrigin(plugin))
                .FirstOrDefault(c => c.ChangeType == PendingChangeConstants.CreateChangeType)?.Id;
            if (createChangeId == null) continue;

            _changes.RevertGroup(createChangeId.Value);
            reverted.Add(formKey);
        }
        return reverted;
    }

    // Stages a $delete change per plainTarget + nullifications for editable inbound refs, same as the
    // pre-#143 flow. toNullify is precomputed by the caller (before any pending-create revert, so a
    // BlockedByReferences failure never happens after a revert side effect already landed).
    // revertedFormKeys (from the sibling pending-create targets, if any) decides whether the result
    // is a plain Staged or a Mixed that reports both outcomes distinctly.
    private DeleteRecordsResult StagePlainDeletes(
        IReadOnlyList<(string FormKey, string Plugin)> plainTargets,
        string source,
        List<(string SourceFormKey, string SourcePlugin, string FieldPath, string RecordType)> toNullify,
        List<string> revertedFormKeys)
    {
        var members = BuildDeleteMembers(plainTargets, source);
        AddNullificationMembers(members, toNullify, source);

        var group = _changes.StageChanges(members);
        return revertedFormKeys.Count > 0
            ? new DeleteRecordsResult.Mixed(group, revertedFormKeys)
            : new DeleteRecordsResult.Staged(group);
    }

    // Build group members: one delete change per target
    private List<GroupMember> BuildDeleteMembers(
        IReadOnlyList<(string FormKey, string Plugin)> plainTargets, string source)
    {
        var members = new List<GroupMember>();
        foreach (var (formKey, plugin) in plainTargets)
        {
            var recordType = _query.GetRecordType(formKey) ?? "unknown";
            var placement = _query.GetPlacement(formKey, plugin, ResolveOrigin(plugin));
            members.Add(new GroupMember(
                formKey, plugin, recordType,
                PendingChangeConstants.DeleteChangeType,
                PendingChangeConstants.DeleteFieldPath,
                PendingChangeConstants.NullElement,
                PendingChangeConstants.NullElement,
                source,
                placement?.ParentCell,
                placement?.PlacementGroup,
                ResolveOrigin(plugin)));
        }
        return members;
    }

    // Scans references to targets; partitions into blocked (referenced by an immutable plugin) vs.
    // nullifiable (referenced only by editable plugins).
    private (List<BlockedReference> Blocked, List<(string SourceFormKey, string SourcePlugin, string FieldPath, string RecordType)> ToNullify)
        PartitionInboundReferences(IReadOnlyList<(string FormKey, string Plugin)> targets, IGameSession session)
    {
        var targetFormKeys = targets.Select(t => t.FormKey).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var immutablePlugins = session.Plugins
            .Where(p => p.IsImmutable)
            .Select(p => p.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        return PartitionInboundReferences(targets, targetFormKeys, immutablePlugins);
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
    // (StageChanges upserts on (form_key, plugin, field_path)).
    private void AddNullificationMembers(
        List<GroupMember> members,
        List<(string SourceFormKey, string SourcePlugin, string FieldPath, string RecordType)> toNullify,
        string source)
    {
        foreach (var fieldGroup in toNullify.GroupBy(t => (t.SourceFormKey, t.SourcePlugin, TopLevelFieldName(t.FieldPath), t.RecordType)))
        {
            var (sourceFormKey, sourcePlugin, topLevelField, recordType) = fieldGroup.Key;
            var currentRecord = _query.GetRecordForPlugin(sourceFormKey, sourcePlugin, ResolveOrigin(sourcePlugin))!;
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
                source,
                ParentCell: null, PlacementGroup: null, Origin: ResolveOrigin(sourcePlugin)));
        }
    }

    public RenumberResult Renumber(string formKey, uint newFormId, string plugin, string source)
    {
        var session = _sessionManager.Session;
        if (session == null) return new RenumberResult.NoSession();

        // #306: null (no load-order member of this name) refuses here too — proceeding would only
        // stage a renumber that could later fail at save time instead of being refused up front.
        if (session.LoadOrderPlugin(plugin) is not { IsImmutable: false })
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
                source,
                ParentCell: null, PlacementGroup: null, Origin: ResolveOrigin(plugin)),
        };

        // FieldEdit changes for cross-plugin editable references only
        var crossPluginRefs = allRefs
            .Where(r => !r.Plugin.Equals(plugin, StringComparison.OrdinalIgnoreCase) &&
                        !immutablePlugins.Contains(r.Plugin))
            .ToList();

        foreach (var fieldGroup in crossPluginRefs.GroupBy(r => (r.FormKey, r.Plugin, TopLevelFieldName(r.FieldPath), r.RecordType)))
        {
            var (sourceFormKey, sourcePlugin, topLevelField, refRecordType) = fieldGroup.Key;
            var currentRecord = _query.GetRecordForPlugin(sourceFormKey, sourcePlugin, ResolveOrigin(sourcePlugin))!;
            var fieldMap = currentRecord.Fields.ToDictionary(fv => fv.Metadata.Name, fv => fv.Value);
            var oldValue = JsonSerializer.SerializeToElement(fieldMap[topLevelField]);
            var newValue = ReplaceFormKey(oldValue, formKey, newFormKey);

            members.Add(new GroupMember(
                sourceFormKey, sourcePlugin, refRecordType,
                PendingChangeConstants.FieldEditChangeType,
                topLevelField,
                oldValue,
                newValue,
                source,
                ParentCell: null, PlacementGroup: null, Origin: ResolveOrigin(sourcePlugin)));
        }

        var group = _changes.StageChanges(members);
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
    // rejection, issue #335/ADR-0038) behind one call so StageEdit only branches on a single
    // early-out here, not two.
    private StageEditResult? CheckHeaderStageGuards(
        string plugin, string recordType, Dictionary<string, JsonElement> fields,
        Dictionary<string, JsonElement> oldValues, IGameSession session)
    {
        StageEditResult? eslResult = CheckEslEligibility(plugin, recordType, fields, oldValues, session.GameRelease);
        return eslResult ?? CheckMasterEdit(recordType, fields);
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

    // Issue #335/ADR-0038 stage-time guard for the header's masters field: rejects any direct
    // edit outright, unconditionally — ADR-0038 decides nothing may declare a master except
    // content that references it, so there is nothing left to validate about a proposed value,
    // shape included. This slice only closes the direct-edit path; it does not itself derive
    // masters from content — GetEffectiveMasters below still returns whatever was last staged or
    // committed, not a live union over the plugin's content (that derivation is #336). Was issue
    // #86's validated, add-only plugin-reference array; #283 design review found a real but
    // out-of-scope use for a manually-declared master (load-order pinning) and ADR-0038 closed
    // the direct-edit path entirely rather than keep validating it. Never runs against
    // StageMissingMasters' own auto-add-master pending change below — that upserts the pending
    // change directly, bypassing StageEdit (and this guard) entirely, per invariant B.
    private static StageEditResult.InvalidReferences? CheckMasterEdit(
        string recordType, Dictionary<string, JsonElement> fields)
    {
        if (recordType != Records.HeaderIndexer.TableName) return null;
        if (!fields.TryGetValue(HeaderMastersField, out var newMastersJson)) return null;

        return new StageEditResult.InvalidReferences([
            new ReferenceValidationError(HeaderMastersField, newMastersJson.GetRawText(), "read_only", [])
        ]);
    }

    private static List<string> ReadStringArray(JsonElement el) =>
        el.ValueKind == JsonValueKind.Array
            ? el.EnumerateArray().Select(e => e.GetString() ?? "").ToList()
            : [];

    // Issue #98: the committed record index alone misses pending creates/renumbers, so a plugin
    // could be flagged ESL while a not-yet-saved change would make it invalid. Unions the committed
    // native FormKeys with pending create/renumber targets, and drops any committed FormKey a
    // pending renumber has moved away from (else a renumber that *fixes* an out-of-range record
    // would leave the stale high FormID counted against eligibility).
    private IReadOnlyList<string> GetEffectiveNativeFormKeys(string plugin)
    {
        var committed = _query.GetNativeFormKeys(plugin, ResolveOrigin(plugin));
        var (added, removed) = _changes.GetPendingNativeFormKeyChanges(plugin, ResolveOrigin(plugin));
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

        var pending = _changes.GetPendingFields(headerFormKey, plugin, ResolveOrigin(plugin));
        if (pending != null && pending.TryGetValue(HeaderFlagsField, out var pendingFlags))
            return (ReadFlagsLong(pendingFlags) & eslBit) != 0;

        var committedFlags = _query.GetRecordForPlugin(headerFormKey, plugin, ResolveOrigin(plugin))?.Fields
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
        string recordType,
        GameRelease release)
    {
        var result = new List<PendingFormRef>();
        if (!schemas.TryGetValue(recordType, out var schema)) return result;
        var colsByName = schema.RecordColumns.ToDictionary(c => c.Name);
        var conditionCodec = ConditionCodecRegistry.For(release.ToCategory());
        foreach (var (fieldPath, newValue) in fields)
        {
            if (VmadPath.IsVmadPath(fieldPath))
            {
                ExtractVmadValueRefs(fieldPath, newValue, result);
            }
            else if (ConditionPath.IsConditionPath(fieldPath))
            {
                ExtractConditionValueRefs(fieldPath, newValue, result);
            }
            // #154: any of the record's condition-owning fields (not just "Conditions").
            else if (conditionCodec != null && conditionCodec.IsConditionListField(schema.RecordType, fieldPath))
            {
                ExtractConditionListRefs(fieldPath, newValue, result);
            }
            else if (colsByName.TryGetValue(fieldPath, out var col))
            {
                FormRefPathBuilder.Walk(col, _ => (object?)newValue, (path, fk) =>
                                result.Add(new PendingFormRef(fieldPath, path, fk)));
            }
        }
        return result;
    }

    // Which FormKeys a VMAD value carries is the codec's business; the path they hang off is ours.
    private static void ExtractVmadValueRefs(string fieldPath, JsonElement value, List<PendingFormRef> into)
    {
        foreach (var fk in VmadCodec.ValueFormKeys(value))
            into.Add(new PendingFormRef(fieldPath, fieldPath, fk));
    }

    // A condition edit's FormKey-bearing shapes: a Form-category "Parameter\<n>" or "Comparison"
    // (Use-Global) value is a bare FormKey string; "RunOn" carries one inside its "reference" member.
    // Guarded by FormKey.TryFactory so a String-category parameter's plain text (also a JSON string,
    // same wire shape) is never mistaken for a reference.
    private static void ExtractConditionValueRefs(string fieldPath, JsonElement value, List<PendingFormRef> into)
    {
        if (!ConditionPath.TryParse(fieldPath, out _, out _, out var subField)) return;

        if (subField == "RunOn" && value.ValueKind == JsonValueKind.Object
            && value.TryGetProperty("reference", out var refEl) && refEl.ValueKind == JsonValueKind.String
            && FormKey.TryFactory(refEl.GetString()!, out var refFk))
        {
            into.Add(new PendingFormRef(fieldPath, fieldPath, refFk.ToString()));
            return;
        }

        if ((subField == "Comparison" || ConditionPath.TryParseParameterIndex(subField, out _))
            && value.ValueKind == JsonValueKind.String && FormKey.TryFactory(value.GetString()!, out var fk))
        {
            into.Add(new PendingFormRef(fieldPath, fieldPath, fk.ToString()));
        }
    }

    // A whole-list restage (#153) carries the same FormKey-bearing shapes as a per-field condition
    // edit (ExtractConditionValueRefs), just once per element instead of once per staged field: each
    // element's Form-category parameters, its "runOnReference", and (when useGlobal) its
    // "comparisonGlobal".
    private static void ExtractConditionListRefs(string fieldPath, JsonElement value, List<PendingFormRef> into)
    {
        if (value.ValueKind != JsonValueKind.Array) return;

        foreach (var el in value.EnumerateArray())
        {
            if (el.ValueKind != JsonValueKind.Object) continue;

            if (el.TryGetProperty("runOnReference", out var refEl) && refEl.ValueKind == JsonValueKind.String
                && FormKey.TryFactory(refEl.GetString()!, out var refFk))
            {
                into.Add(new PendingFormRef(fieldPath, fieldPath, refFk.ToString()));
            }

            if (el.TryGetProperty("useGlobal", out var ugEl) && ugEl.ValueKind == JsonValueKind.True
                && el.TryGetProperty("comparisonGlobal", out var cgEl) && cgEl.ValueKind == JsonValueKind.String
                && FormKey.TryFactory(cgEl.GetString()!, out var cgFk))
            {
                into.Add(new PendingFormRef(fieldPath, fieldPath, cgFk.ToString()));
            }

            if (!el.TryGetProperty("parameters", out var paramsEl) || paramsEl.ValueKind != JsonValueKind.Array)
                continue;

            foreach (var p in paramsEl.EnumerateArray())
            {
                if (p.ValueKind != JsonValueKind.Object) continue;
                if (p.TryGetProperty("category", out var catEl) && catEl.GetString() == "Form"
                    && p.TryGetProperty("formKey", out var fkEl) && fkEl.ValueKind == JsonValueKind.String
                    && FormKey.TryFactory(fkEl.GetString()!, out var pfk))
                {
                    into.Add(new PendingFormRef(fieldPath, fieldPath, pfk.ToString()));
                }
            }
        }
    }

    // #296: the lookup itself, including its #34 fallback caveat, now lives in one place —
    // PluginOriginResolver — shared with RecordQueryService and WorldspaceQueryService rather than
    // reimplemented per caller.
    private string ResolveOrigin(string plugin) =>
        PluginOriginResolver.Resolve(_sessionManager.Session, plugin);

    private (StageEditResult? earlyOut, IGameSession? session, string? recordType) ValidateEditContext(
        string formKey, string plugin)
    {
        var session = _sessionManager.Session;
        if (session == null) return (new StageEditResult.NoSession(), null, null);

        // #306: null (no load-order member of this name) refuses here too — proceeding would only
        // stage an edit that could later fail at save time instead of being refused up front.
        if (session.LoadOrderPlugin(plugin) is not { IsImmutable: false })
            return (new StageEditResult.PluginImmutable(plugin), null, null);

        var recordType = _query.GetRecordType(formKey);
        (StageEditResult? earlyOut, IGameSession? session, string? recordType) result = recordType == null
            ? (new StageEditResult.RecordNotFound(), null, null)
            : (null, session, recordType);
        return result;
    }
}

