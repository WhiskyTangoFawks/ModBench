using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Session;

namespace MEditService.Core.Queries;

// Origin (#269 / ADR-0036): opaque here — the mod folder that provided this plugin, or a reserved
// PluginOrigin value. Nothing keys on it yet; see PluginMetadata.
//
// MasterIssues (#277 / ADR-0037): this plugin's own declared masters that aren't resolvable in the
// session — never a transitive/cascaded fact about a master's own masters. Empty, never null, for
// a plugin whose masters all resolved. See MasterResolution.Classify.
public record PluginResponse(
    string Name,
    string Path,
    int LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable,
    bool Participates,
    string Origin,
    IReadOnlyList<MasterIssue> MasterIssues)
{
    public static PluginResponse FromMetadata(PluginMetadata m, IReadOnlyList<MasterIssue>? masterIssues = null) =>
        new(m.Name, m.Path, m.LoadOrderIndex, m.IsLight, m.IsMaster, m.Masters, m.RecordCount, m.IsImmutable, m.Participates, m.Origin,
            masterIssues ?? []);
}

public record RecordSummary(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId);

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);

public record FieldMetadata(
    string Name,
    string Type,
    bool IsArray,
    IReadOnlyList<string> ValidFormKeyTypes,
    IReadOnlyList<string> EnumValues,
    FieldMetadata? ElementType = null,          // for 'array': element schema
    IReadOnlyList<FieldMetadata>? Fields = null, // for 'struct': sub-field schemas
    bool IsSortable = false,                     // true when element is a pure FormLink
    bool AllowsNull = false,                     // for 'formKey': true when the Mutagen type is IFormLinkNullable<T>
    bool IsBitmask = false,                      // for 'enum': true when the C# enum has [Flags]
    IReadOnlyList<string>? EnumBitValues = null); // for 'enum' + IsBitmask: decimal string bit values aligned with EnumValues

// Value contract: a bitmask field (Metadata.IsBitmask) carries its combined flags as a decimal
// string, not a number — so values above 2^53 survive JSON round-tripping without IEEE 754 loss.
public record FieldValue(FieldMetadata Metadata, object? Value, string? CheckError = null);

// RecordType (issue #3): the schema table name (e.g. "NPC_") this record belongs to — needed by
// the webview's "Copy as New Record" column-header action, which must supply a RecordType up
// front to CreateRecord (schema validation happens before the TemplateFormKey is even read; see
// EditOrchestrator.CreateRecordCore). Defaults to "" for the many pre-existing call sites (mostly
// test fixtures) that don't need it — always populated for real reads (ReadDetail knows its own
// schema's TableName).
// Origin (#272 / ADR-0036): the mod folder that provided this row's physical file, or a reserved
// PluginOrigin value — paired with Plugin, never encoded into it. Required (#275): every
// construction (including a test fixture) must say which origin, not fall back to one silently.
// Declared before the two still-defaulted trailing fields only because C# requires a required
// parameter to precede any optional one — callers may still pass it by name in any position.
public record RecordDetail(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    string Origin,
    Dictionary<string, object?>? PendingFields = null,
    string RecordType = "");

public record CompareOverride(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    Dictionary<string, object?>? PendingFields,
    ConflictThis ConflictThis,
    string Origin,
    string RecordType = "")
    : RecordDetail(FormKey, Plugin, LoadOrderIndex, IsWinner, EditorId, Fields, Origin, PendingFields, RecordType);

// Resolutions (ADR-0031): only populated for a scalar formKey-typed leaf, keyed by plugin like
// Values/CellStates — one entry per plugin whose cell holds a FormKey value. Never populated on a
// struct/array field's own FieldDiff (its Values aren't FormKey strings) and never aggregated up
// from Children — each leaf's signal is independent, so a dangling sibling can't hide a live
// hyperlink/affordance on the leaf next to it.
//
// ConflictAll (#114): this node's own bottom-up conflict classification — this field/element's own
// CellStates folded with the same ConflictAll aggregate of every descendant (recursively), via the
// shared ConflictRules.Reduce/Escalate rules. Scoped to exactly this FieldDiff's subtree — distinct
// from ClassifyResult.ConflictAll (record-wide, drives the Plugins-tree badge), which is computed
// only from the top-level Diffs and is unaffected by this field's addition. Drives the compare
// grid's per-row background (ADR-0016): a leaf's own value; a struct/array's aggregate while
// collapsed, deferred to its children while expanded.
public record FieldDiff(
    string FieldName,
    [property: ColumnKeyed] Dictionary<string, object?> Values,
    string WinnerColumn,
    object? WinnerValue,
    [property: ColumnKeyed] IReadOnlyDictionary<string, ConflictThis> CellStates,
    ConflictAll ConflictAll,
    IReadOnlyList<FieldDiff>? Children = null,
    [property: ColumnKeyed] IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null);

public record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

// VMAD aligned diff — mirrors FieldDiff so the frontend reuses the same per-plugin cell + CellStates rendering.
public record VmadPropertyDiff(
    string Name,                                       // sort key = propertyName / member name / "[i]"
    string Kind,                                       // "scalar"|"object"|"array"|"struct"|"structList"|"variable"
    [property: ColumnKeyed] Dictionary<string, object?> Values,                // per-plugin leaf value (scalar / "FormKey [Alias]" / null when absent or has children)
    [property: ColumnKeyed] Dictionary<string, string> Types,                  // per-plugin property Type (types differing across plugins → a conflict)
    string WinnerColumn,
    [property: ColumnKeyed] IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff>? Children,          // struct members (by name) / array elements (by index), aligned & recursive
                                                        // Raw: per-plugin struct subtree in the editable node-tree shape — a struct carries a list of
                                                        // member nodes; a structList carries a list of per-instance member-node lists. Populated only
                                                        // for struct/structList. The frontend patches one member by path and restages the whole value
                                                        // (atomic column, ADR-0019).
    [property: ColumnKeyed] Dictionary<string, object?>? Raw = null,
    // ADR-0031: only populated on a Kind=="object" leaf, keyed by plugin like Values/CellStates —
    // never aggregated up from Children, so a dangling sibling Object can't hide a live
    // hyperlink/affordance on the leaf next to it.
    [property: ColumnKeyed] IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null);

public record VmadScriptDiff(
    string Name,                                       // sort key = ScriptName
    [property: ColumnKeyed] Dictionary<string, string?> Flags,                 // per-plugin script flags; null = script absent in that plugin
    string WinnerColumn,
    [property: ColumnKeyed] IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff> Properties);

public record VmadCompare(IReadOnlyList<VmadScriptDiff> Scripts);

// Conditions (CTDA) aligned across plugins — one ConditionDiff per condition row, per owning field.
// PerPlugin holds the neutral parsed condition (null = that plugin lacks the row); the frontend
// renders the summary and expands to typed fields from it. Two-axis coloring like ordinary fields.
public record ConditionDiff(
    int Index,
    [property: ColumnKeyed] Dictionary<string, Schema.ParsedCondition?> PerPlugin,
    string WinnerColumn,
    [property: ColumnKeyed] IReadOnlyDictionary<string, ConflictThis> CellStates,
    // Per-field two-axis states for the expanded view, keyed by field id ("function", "operator",
    // "gate", "runOn", "comparison", "param:{i}"), so only fields that actually differ are colored.
    // #272 review: the outer key is a field id, not a column — [ColumnKeyed] here means "the
    // *inner* dictionary's keys are columns" (CompareResultColumnKeyIntegrityTests detects this
    // nesting structurally); the outer field-id keys are never checked against ColumnKey.Of.
    [property: ColumnKeyed] IReadOnlyDictionary<string, IReadOnlyDictionary<string, ConflictThis>> FieldCellStates,
    // #166: FormKey→EditorID resolution (ADR-0031) for a condition's three FormKey-bearing slots —
    // keyed the same way as FieldCellStates ("runOn", "comparison", "param:{i}"; never "function" /
    // "operator" / "gate", which carry no FormKey), then by plugin. Unlike VmadPropertyDiff's single
    // per-leaf Resolutions, a condition has up to three independent FormKey slots live at once, so
    // one shared per-leaf dictionary would collide them — this mirrors FieldCellStates' shape
    // instead. Null (not just empty) when no resolver was passed, matching VmadPropertyDiff's own
    // resolver-absent convention.
    [property: ColumnKeyed] IReadOnlyDictionary<string, IReadOnlyDictionary<string, FormKeyResolution>>? FieldResolutions = null);

public record ConditionGroupDiff(string FieldPath, IReadOnlyList<ConditionDiff> Conditions);

public record ConditionCompare(IReadOnlyList<ConditionGroupDiff> Groups);

// HasVmad (issue #179): the record type's schema-level capability to carry a VMAD subrecord at
// all (Schema.RecordTableSchema.HasVmad, reflected from Mutagen's IHaveVirtualMachineAdapterGetter)
// — distinct from Vmad above, which is per-record *data* (null whenever no plugin happens to have
// scripts, even for a VMAD-capable type like an un-scripted NPC). The frontend gates whether it
// renders a Scripts (VMAD) section at all on HasVmad, not on Vmad's presence.
public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll,
    bool HasVmad,
    VmadCompare? Vmad = null,
    ConditionCompare? Conditions = null);

public record PluginRecordTypeCount(string Type, int Count, string DisplayName);

public record SessionFilterRequest(string Sql);
public record SessionFilterResponse(string? Sql);

public record SessionLoadResponse(string Status, IReadOnlyList<PluginLoadFailure> Failures);
public record SessionLoadExplicitRequest(
    IReadOnlyList<ExplicitPlugin> Plugins, string GameDirectory, string GameRelease = "Fallout4");
// Origin (#269 / ADR-0036): Mod Management resolves this — the mod folder that provided the
// file, or one of the reserved values (PluginOrigin.DataDirectory / MO2's overwrite). Required —
// the one production caller (modbench/src/modmanager/explicitSession.ts) already resolves it, so
// there is nothing left to default (#275).
// Participates (#270 / ADR-0035): the plugins.txt `*` prefix — whether this plugin loads in the
// game and so competes for winner. Nullable purely to make an omitted field detectable: a plain
// bool would bind a missing property to false, quietly making every plugin non-participating, so
// nothing would win any FormKey and the conflict picture would be empty but well-formed. The
// endpoint rejects null (400) rather than choosing a value on the caller's behalf.
public record ExplicitPlugin(string Name, string Path, string Origin, bool? Participates);

// Origin (#296 / ADR-0036): the mod folder that provided the source row's physical file, or a
// reserved PluginOrigin value — additive alongside Plugin, same shape as RecordDetail.Origin
// (#272). GetReferences never filtered by plugin, so this isn't a filter gap; without Origin here,
// two same-filename sources referencing the same target were indistinguishable in the result.
public record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);

public record CreateRecordResult(string FormKey, Guid GroupId);

// A save reports success even when the post-commit reindex failed: the file is written and the
// pending changes are consumed, only the read model is stale. `ReindexFailure` is null on the
// happy path and populated otherwise, so the frontend can surface the stale-index warning
// (#127, ADR-0026 integrity tier). Mirrors SessionLoadResponse.Failures' structured shape.
public record SaveGroupResponse(
    IReadOnlyDictionary<string, SaveResult> ByPlugin,
    ReindexFailure? ReindexFailure);

public record BlockedReference(
    string TargetFormKey,
    string SourceFormKey,
    string SourcePlugin,
    string FieldPath,
    string RecordType,
    string? EditorId);

public record DeleteRecordTarget(string FormKey, string Plugin);

// #143 / #147: DeleteRecords has three outcomes (staged delete, reverted create, or a mix of both),
// but they all land on the same 200 — one status code answered by multiple distinct response bodies
// is the #147 anti-pattern (Swashbuckle has no oneOf machinery for it and silently keeps only the
// last-declared .Produces<T>() type). This envelope keeps the wire honest: exactly one documented
// schema, with the two fields null when their outcome didn't happen. StagedGroup is non-null when
// any target staged a delete; RevertedFormKeys lists every target reverted instead — never both
// null, and both populated for a mixed batch.
public record DeleteRecordsResponse(ChangeGroup? StagedGroup, IReadOnlyList<string>? RevertedFormKeys);

public record DeleteRecordsRequest(IReadOnlyList<DeleteRecordTarget> Records);

// #147: PatchRecord/CopyRecordTo's 422 had the same anti-pattern as #143's DeleteRecords 200 —
// one status code, two undeclared shapes (a bare ReferenceValidationError[] for reference/
// append-only/type-mismatch/null-not-allowed failures, ProblemDetails for read-only-fields/
// ESL-ineligible). This envelope keeps the wire honest: exactly one documented 422 schema.
// FieldErrors is non-null for reference-style failures; Detail is non-null for the rest — never
// both populated (unlike DeleteRecordsResponse, StageEditResult only ever reports one outcome).
public record PatchRecordValidationError(IReadOnlyList<ReferenceValidationError>? FieldErrors, string? Detail);

public record HealthResponse(string Status);
