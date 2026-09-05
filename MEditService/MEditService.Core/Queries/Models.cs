using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Core.Queries;

// One Kind B diagnosis. Text is PluginDiagnosis.Describe()'s exact refusal fragment, so the
// Problems panel and the Track refusal share one vocabulary; Anchor/DefectClass/Tail ride
// separately so the frontend can route a repair without re-parsing prose.
public record PluginDiagnosisReport(
    string Plugin,
    string Origin,
    string? Anchor,
    string DefectClass,
    string? Tail,
    string Message,
    string Text);

public record PluginResponse(
    string Name,
    string Path,
    // ADR-0044: the plugins.txt slot past the forced masters, or null when no line names this
    // copy; record-level LoadOrderIndex values are sort keys and put such a copy last.
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable,
    // Participates (ADR-0044): derived — Enabled AND Winning AND listed. The only copies that
    // compete for winner or count in a conflict.
    bool Participates,
    string Origin,
    // MasterIssues (ADR-0037): this plugin's own unresolvable masters, never a transitive fact.
    // Empty rather than null when every master resolved.
    IReadOnlyList<MasterIssue> MasterIssues,
    // InLoadOrder (ADR-0035, ADR-0044): derived — the winning copy of a listed name, enabled
    // or not. False for a losing copy or an unlisted file. See PluginMetadata.InLoadOrder.
    bool InLoadOrder,
    // Enabled / Winning (ADR-0044): the two registration facts beside the slot, as Mod Management
    // stated them — what lets a row say *why* it does not participate (disabled, or overridden).
    bool Enabled,
    bool Winning,
    // HasMatchingRecords (ADR-0035 amending ADR-0018): a record filter prunes records, never a
    // plugin row, so this is what a caller uses to decide whether to offer a chevron. Defaults
    // to true: only the plugin listing answers inside a filter.
    bool HasMatchingRecords = true,
    // IsTracked (ADR-0041): whether the mod folder holds a git directory, which editing requires
    // and viewing never does. False with no mod folder at all (IsImmutable tells the two apart).
    // Derived on every read: the directory can vanish outside Modbench.
    bool IsTracked = false)
{
    public static PluginResponse FromMetadata(
        PluginMetadata m, IReadOnlyList<MasterIssue>? masterIssues = null, bool hasMatchingRecords = true)
    {
        return new(m.Name, m.Path, m.LoadOrderIndex, m.IsLight, m.IsMaster, m.Masters, m.RecordCount, m.IsImmutable, m.Participates, m.Origin,
            masterIssues ?? [], m.InLoadOrder, m.Enabled, m.Winning, hasMatchingRecords,
            Source.ModFolders.IsEditable(m.Origin, m.Path));
    }
}

// A tri-state rather than two booleans: the states are mutually exclusive, and a future Deleted
// would be a wire addition, not a reshape. Deleted is absent because a working-tree-deleted
// record has no Search() row to describe.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WorkingTreeState { None, Modified, Added }

// Origin (ADR-0036): additive alongside Plugin; without it two same-filename plugins listed
// together are indistinguishable rows.
public record RecordSummary(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    string Origin,
    // Defaults to None (test fixtures, GetOverrideStack's own unrelated read paths) — Search() is
    // the only real producer of a non-None value; see DuckDbRecordIndex.Search.
    WorkingTreeState WorkingTreeState = WorkingTreeState.None,
    // Whether at least one container_child row names this FormKey as parent — the Plugins tree's
    // expand chevron for a qust/dial row. Search() is the only producer of true; every
    // other construction site has nothing to report.
    bool HasContainerChildren = false);

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);

/// <summary>BitValue is a decimal string so a bit above 2^53 survives JSON without IEEE 754
/// loss, null for a plain enum. Label is null for a member that is already the game's own
/// vocabulary.</summary>
public record EnumMember(string Value, string? BitValue = null, string? Label = null)
{
    /// <summary>The one definition of "flags rather than a closed choice" — a field, a column and
    /// the webview's flagBits all answer it this way. An enum with no members is not one.</summary>
    public static bool IsBitmask(IReadOnlyList<EnumMember> members) =>
        members.Count > 0 && members.All(m => m.BitValue != null);
}

public record FieldMetadata(
    string Name,
    string Type,
    bool IsArray,
    IReadOnlyList<string> ValidFormKeyTypes,
    // For 'enum': the field's members, in the order the schema lists them. That order is a
    // contract, not a rendering detail — a discriminator's first member is the leaf a new array
    // element is built as (ArrayOpWriter).
    IReadOnlyList<EnumMember> EnumMembers,
    FieldMetadata? ElementType = null,          // for 'array': element schema
    IReadOnlyList<FieldMetadata>? Fields = null, // for 'struct': sub-field schemas
    bool IsSortable = false,                     // true when element is a pure FormLink
    bool AllowsNull = false,                     // for 'formKey': true when the Mutagen type is IFormLinkNullable<T>

    // Null for an ordinary field, whose row label is its own name; set by the abstract-union
    // discriminator, whose name is a wire name.
    string? DisplayLabel = null,             // what to title the row, when Name is a wire name

    // This field names which concrete class its object is, read off the payload before that object
    // exists (ListLeaves.ResolveListElementType). True for concrete_type and OMOD's
    // value_type, false for every other field.
    bool IsDiscriminator = false,

    // For an enum whose value decides which sibling fields carry data; null when every sibling is
    // always in use. Keyed by value, not aligned positionally with EnumMembers, so a reordering
    // can never re-point a row.
    IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUse = null,

    // The element member(s) identifying an element (xEdit's wbArrayS); null for a positional
    // array. Aligned across plugins by key, written back in key order, duplicates refused. A name
    // may be dotted to reach one struct member down.
    IReadOnlyList<string>? KeyMembers = null,

    // For 'struct': the Loqui/CLR class the schema declares, null for every other type. Distinct
    // from a discriminator's value, which says which class an object turned out to be. Serialized
    // nulls stay on all four nullables here.
    string? LeafTypeName = null)
{
    /// <summary>Derived, not stored: a member's own BitValue is the only place that fact lives.
    /// Off the wire because the webview asks the members the same question (flagBits).</summary>
    [JsonIgnore]
    public bool IsBitmask => EnumMember.IsBitmask(EnumMembers);
}

// Value contract: a bitmask field (Metadata.IsBitmask) carries its combined flags as a decimal
// string, not a number — so values above 2^53 survive JSON round-tripping without IEEE 754 loss.
public record FieldValue(FieldMetadata Metadata, object? Value, string? CheckError = null);

public record RecordDetail(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    // Origin (ADR-0036): paired with Plugin, never encoded into it. Required so every construction
    // says which origin; it precedes the defaulted fields only because C# requires that.
    string Origin,
    // The schema table name; "Copy as New Record" must supply it to CreateRecord up front. Defaults
    // to "" for test fixtures — always populated for real reads.
    string RecordType = "",
    // The record header's Partial Form flag, independent of any field value; always false for a
    // record that cannot carry one (the plugin header). Drives field exclusion and column dimming.
    bool IsPartialForm = false,
    // Whether this record type could carry the flag at all, so the webview can render its Partial
    // Form toggle without duplicating the container-type table client-side.
    bool IsPartialFormable = false);

public record CompareOverride(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    ConflictThis ConflictThis,
    string Origin,
    string RecordType = "",
    bool IsPartialForm = false,
    bool IsPartialFormable = false)
    : RecordDetail(
        FormKey, Plugin, LoadOrderIndex, IsWinner, EditorId, Fields, Origin, RecordType, IsPartialForm,
        IsPartialFormable);

public record FieldDiff(
    string FieldName,
    [property: ColumnKeyed] Dictionary<string, object?> Values,
    string WinnerColumn,
    object? WinnerValue,
    [property: ColumnKeyed] IReadOnlyDictionary<string, ConflictThis> CellStates,
    // This subtree's own aggregate, distinct from the record-wide ClassifyResult.ConflictAll; drives
    // the compare grid's per-row background (ADR-0016): a struct's aggregate while collapsed.
    ConflictAll ConflictAll,
    IReadOnlyList<FieldDiff>? Children = null,
    // ADR-0031: only on a scalar formKey leaf, keyed like Values; never aggregated up from Children,
    // so a dangling sibling can't hide a live hyperlink on the leaf next to it.
    [property: ColumnKeyed] IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null);

public record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll);

public record PluginRecordTypeCount(string Type, int Count, string DisplayName);

public record FilterRequest(string Sql);
public record FilterResponse(string? Sql);

// CrashRepairOffers: tracked plugins found stale/missing against Modbench's own record, surfaced
// the same structured way Failures is (ADR-0026), never a second endpoint or poller: either
// condition can only appear through a compile this process drives or a restart.
public record LoadOrderResponse(
    string Status, IReadOnlyList<PluginLoadFailure> Failures, IReadOnlyList<CrashRepairOffer> CrashRepairOffers);
// ADR-0044: Mod Management's snapshot. InstanceRoot (ADR-0001) must be the MO2 instance rather
// than anything wider, because Origin is a mod folder name unique only within one.
public record LoadOrderRequest(
    IReadOnlyList<LoadOrderPlugin> Plugins, string GameDirectory, string InstanceRoot, string GameRelease = "Fallout4");
// Slot is null when no plugins.txt line names it. Enabled and Winning are nullable only so an
// omitted field is detectable: a plain bool would bind a missing property to false, quietly
// making every copy non-participating.
public record LoadOrderPlugin(string Name, string Path, string Origin, int? Slot, bool? Enabled, bool? Winning);

// Origin (ADR-0036): additive alongside Plugin; without it two same-filename sources referencing
// the same target are indistinguishable.
public record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);

public record HealthResponse(string Status);

// ADR-0041: one field edit on one plugin's copy. Value is a raw JsonElement: a value is whatever
// its schema says (a complex field's whole JSON), so typing it here would re-declare the schema
// on the wire.
public record RecordFieldEditRequest(
    string Plugin,
    string Origin,
    string FieldPath,
    JsonElement Value);

/// <summary>The success shape for an applied edit. Refusals never come back through this record —
/// they are ProblemDetails carrying a <c>refusal</c> extension, so an HTTP client's ordinary
/// success check is also the correct check (ADR-0026).</summary>
public record RecordFieldEditResponse(bool Applied, string FormKey, string FieldPath);

// The three lifecycle gestures' wire shapes, on the same door (Plugin/Origin as the compound
// identity, refusals as ProblemDetails carrying the same `refusal` extension) EditField already
// established.

/// <summary><see cref="FormKey"/> null means auto-allocate the next free local FormID (both-refs
/// collision-safe); non-null is xEdit's typed-FormID path.</summary>
public record RecordCreateRequest(string Origin, string RecordType, string? EditorId, string? FormKey);

public record RecordCreateResponse(bool Applied, string FormKey, string RecordType);

public record RecordDeleteRequest(string Plugin, string Origin);

public record RecordDeleteResponse(bool Applied, string FormKey);

/// <summary><see cref="NewFormKey"/> null means auto-allocate; non-null is xEdit's typed-FormID
/// renumber path.</summary>
public record RecordRenumberRequest(string Plugin, string Origin, string? NewFormKey);

public record RecordRenumberResponse(bool Applied, string OldFormKey, string NewFormKey);

/// <summary>The Renumber gesture's FormID input box's suggested default (<c>RecordEditService.PeekNextFreeFormKey</c>).</summary>
public record NextFreeFormKeyResponse(string FormKey);

// ADR-0041: xEdit's "Copy as Override Into…" / "Copy as New Record Into…". The route's {formKey}
// names the record copied; both plugins travel as ADR-0036 compound identities.

public record RecordCopyAsOverrideRequest(string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin);

public record RecordCopyAsOverrideResponse(bool Applied, string FormKey);

/// <summary><see cref="RequestedFormKey"/> null means auto-allocate the next free local FormID
/// (both-refs collision-safe); non-null is xEdit's typed-FormID path.</summary>
public record RecordCopyAsNewRecordRequest(
    string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin, string? RequestedFormKey);

public record RecordCopyAsNewRecordResponse(bool Applied, string SourceFormKey, string NewFormKey);
