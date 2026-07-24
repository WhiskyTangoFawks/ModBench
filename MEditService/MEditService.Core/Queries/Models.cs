using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Session;

namespace MEditService.Core.Queries;

public record PluginResponse(
    string Name,
    string Path,
    int LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable)
{
    public static PluginResponse FromMetadata(PluginMetadata m) =>
        new(m.Name, m.Path, m.LoadOrderIndex, m.IsLight, m.IsMaster, m.Masters, m.RecordCount, m.IsImmutable);
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
public record RecordDetail(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
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
    string RecordType = "")
    : RecordDetail(FormKey, Plugin, LoadOrderIndex, IsWinner, EditorId, Fields, PendingFields, RecordType);

// Resolutions (ADR-0031): only populated for a scalar formKey-typed leaf, keyed by plugin like
// Values/CellStates — one entry per plugin whose cell holds a FormKey value. Never populated on a
// struct/array field's own FieldDiff (its Values aren't FormKey strings) and never aggregated up
// from Children — each leaf's signal is independent, so a dangling sibling can't hide a live
// hyperlink/affordance on the leaf next to it.
public record FieldDiff(
    string FieldName,
    Dictionary<string, object?> Values,
    string WinnerPlugin,
    object? WinnerValue,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<FieldDiff>? Children = null,
    IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null);

public record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

// VMAD aligned diff — mirrors FieldDiff so the frontend reuses the same per-plugin cell + CellStates rendering.
public record VmadPropertyDiff(
    string Name,                                       // sort key = propertyName / member name / "[i]"
    string Kind,                                       // "scalar"|"object"|"array"|"struct"|"structList"|"variable"
    Dictionary<string, object?> Values,                // per-plugin leaf value (scalar / "FormKey [Alias]" / null when absent or has children)
    Dictionary<string, string> Types,                  // per-plugin property Type (types differing across plugins → a conflict)
    string WinnerPlugin,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff>? Children,          // struct members (by name) / array elements (by index), aligned & recursive
                                                        // Raw: per-plugin struct subtree in the editable node-tree shape — a struct carries a list of
                                                        // member nodes; a structList carries a list of per-instance member-node lists. Populated only
                                                        // for struct/structList. The frontend patches one member by path and restages the whole value
                                                        // (atomic column, ADR-0019).
    Dictionary<string, object?>? Raw = null,
    // ADR-0031: only populated on a Kind=="object" leaf, keyed by plugin like Values/CellStates —
    // never aggregated up from Children, so a dangling sibling Object can't hide a live
    // hyperlink/affordance on the leaf next to it.
    IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null);

public record VmadScriptDiff(
    string Name,                                       // sort key = ScriptName
    Dictionary<string, string?> Flags,                 // per-plugin script flags; null = script absent in that plugin
    string WinnerPlugin,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff> Properties);

public record VmadCompare(IReadOnlyList<VmadScriptDiff> Scripts);

// Conditions (CTDA) aligned across plugins — one ConditionDiff per condition row, per owning field.
// PerPlugin holds the neutral parsed condition (null = that plugin lacks the row); the frontend
// renders the summary and expands to typed fields from it. Two-axis coloring like ordinary fields.
public record ConditionDiff(
    int Index,
    Dictionary<string, Schema.ParsedCondition?> PerPlugin,
    string WinnerPlugin,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    // Per-field two-axis states for the expanded view, keyed by field id ("function", "operator",
    // "gate", "runOn", "comparison", "param:{i}"), so only fields that actually differ are colored.
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, ConflictThis>> FieldCellStates);

public record ConditionGroupDiff(string FieldPath, IReadOnlyList<ConditionDiff> Conditions);

public record ConditionCompare(IReadOnlyList<ConditionGroupDiff> Groups);

public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll,
    VmadCompare? Vmad = null,
    ConditionCompare? Conditions = null);

public record PluginRecordTypeCount(string Type, int Count, string DisplayName);

public record SessionFilterRequest(string Sql);
public record SessionFilterResponse(string? Sql);

public record SessionLoadResponse(string Status, IReadOnlyList<PluginLoadFailure> Failures);
public record SessionLoadExplicitRequest(
    IReadOnlyList<ExplicitPlugin> Plugins, string GameDirectory, string GameRelease = "Fallout4");
public record ExplicitPlugin(string Name, string Path);

public record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId);

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
