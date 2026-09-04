using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Core.Queries;

// Origin (ADR-0036): opaque here — the mod folder that provided this plugin, or a reserved
// PluginOrigin value. Nothing keys on it yet; see PluginMetadata.
//
// MasterIssues (ADR-0037): this plugin's own declared masters that aren't resolvable in the
// load order — never a transitive/cascaded fact about a master's own masters. Empty, never null, for
// a plugin whose masters all resolved. See MasterResolution.Classify.
// #570: one Kind B diagnosis on a held plugin's binary, as the session-load scan found it.
// Text is PluginDiagnosis.Describe()'s exact refusal fragment (#569) — the Problems panel and the
// Track refusal share one vocabulary by construction. Anchor/DefectClass/Tail ride separately so
// the frontend can decorate rows and (later) route a repair gesture without re-parsing prose.
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
    // ADR-0044: the name's plugins.txt slot past the forced masters, or null when no line names
    // this copy — the plugin-level wire keeps the honest null; record-level LoadOrderIndex values
    // are column sort keys and put such a copy last.
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
    IReadOnlyList<MasterIssue> MasterIssues,
    // InLoadOrder (ADR-0035, ADR-0044): derived — the winning copy of a listed name, enabled
    // or not. False for a losing copy or an unlisted file. See PluginMetadata.InLoadOrder.
    bool InLoadOrder,
    // Enabled / Winning (ADR-0044): the two registration facts beside the slot, as Mod Management
    // stated them — what lets a row say *why* it does not participate (disabled, or overridden).
    bool Enabled,
    bool Winning,
    // HasMatchingRecords (ADR-0035 amending ADR-0018): true with no active filter, or when
    // this plugin owns at least one record the active filter matches. A record filter prunes
    // records and record types, never a plugin row — GetPlugins() always returns every plugin —
    // so this is the one additive fact a caller needs to decide whether the row should still
    // offer a chevron. Defaults true: every call site but RecordQueryService.GetPlugins() returns
    // a single plugin outside any filtered listing, where "has matches" isn't a question being
    // asked.
    bool HasMatchingRecords = true,
    // IsTracked (ADR-0041): whether this plugin's mod folder holds a `.git` — the single
    // fact "editing requires tracking; viewing never does" turns on, and the reason the record
    // editor can render a column as visibly read-only instead of only refusing on attempt. False
    // for a plugin with no mod folder at all (a Data-directory master), which is a different state
    // with a different way out — the record editor tells the two apart by pairing this with
    // IsImmutable, exactly as the backend's own two refusals do.
    //
    // Derived on every read, never cached: tracking *is* the presence of that directory, and it can
    // appear or vanish outside Modbench between one response and the next.
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

// The Plugins-tree listing's own working-tree fact — a tri-state rather than a pair of
// booleans, because the three states (clean / edited-existing / newly created) are mutually
// exclusive by construction (Added implies HasWorkingTreeChange, so a boolean pair would need a
// "check Added before Modified" reading order every consumer would have to remember) and because a
// value addition here (a future Deleted) is a wire addition, not a reshape. Deliberately distinct
// from OverrideStackEntry.HasWorkingTreeChange (Records/RecordDocument.cs) — that seam answers "does
// this one plugin's copy differ from its Head", scoped to a single record already resolved; this one
// answers the same question for every row a listing returns, plus which kind of divergence it is.
// Deleted is not a value here: a working-tree-deleted record has no row
// in Search() at all (EffectiveRelation never held it), so there is nothing for this field to
// describe for that case — surfacing it would need GetRecordTypeCounts/Search to union in
// Head-only rows.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WorkingTreeState { None, Modified, Added }

// Origin (ADR-0036): the mod folder that provided this row's physical file, or a reserved
// PluginOrigin value — additive alongside Plugin, same shape as RecordDetail.Origin. Without
// it, two same-filename plugins listed together (GetRecords/SearchRecords filter by plugin,
// never origin) are indistinguishable rows.
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
    // #560: whether this FormKey has at least one container_child row naming it as parent — the
    // Plugins tree's RecordNode reads this to decide a qust/dial row's expand chevron, rather than
    // showing one for every row of those two types regardless of whether expanding it would yield
    // anything. Defaults to false for the same reason WorkingTreeState defaults to None: Search()
    // is the only real producer of a true value; every other construction site (test fixtures,
    // GetOverrideStack's own unrelated read paths) has nothing to report.
    bool HasContainerChildren = false);

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);

/// <summary>
/// One member of an enum field's closed value set: the wire value, the bit it stands for when the
/// field is a bitmask, and what to show instead of the value when the value is not a word the user
/// should read.
///
/// <para><c>BitValue</c> is a decimal string rather than a number so a bit above 2^53 survives JSON
/// without IEEE 754 loss, and is null for a plain (non-bitmask) enum, which stands for no bit.
/// <c>Label</c> is null for a member that is already the game's own vocabulary — an abstract
/// union's discriminator sets it, its values being Mutagen class names the user is never
/// shown.</para>
/// </summary>
public record EnumMember(string Value, string? BitValue = null, string? Label = null)
{
    /// <summary>Whether these members are a set of flags rather than a closed choice: every one of
    /// them stands for a bit. The one definition of that question — a field, a column and the
    /// webview's own <c>flagBits</c> all answer it the same way. An enum with no members at all
    /// (Fallout 4's <c>NoneProperty</c>) satisfies "every member" vacuously and is not one.</summary>
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

    // For an enum field whose value decides which of its own sibling fields carry data: each of
    // this field's values mapped to the sibling field names that are in use under it. Null for the
    // overwhelming majority of fields, whose siblings are all always in use.
    //
    // A sibling some value names and the current one does not holds no data under the current
    // value: the form-reference and check walks skip it (Records.FormRefPathBuilder), so an unused
    // slot is neither a reference nor a dangling one. #693 owns what the editor does with it.
    // Keyed by value rather than carried as a list positionally aligned with EnumMembers, so a
    // reordering of the domain can never silently re-point a row (#709).
    //
    // Per-game knowledge, so it reaches the schema only as a validated annotation table
    // (Schema.SchemaAnnotations.SiblingsInUse) — Fallout 4's condition function is the first
    // member with one, from Mutagen's own Condition.GetParameterTypes.
    IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUse = null,

    // For 'array': the element member(s), in key order, that identify an element — xEdit's own
    // wbArrayS sort key. Null for a positional array, which is most of them. A keyed array is
    // aligned across plugins by key rather than by index (ConflictClassifier), written back in key
    // order, and refuses two elements sharing a key (Edits.KeyedArrays). A name may be dotted to
    // reach one struct member down (a quest fragment alias's `property.alias`).
    //
    // Per-game knowledge, so it reaches the schema only as a validated annotation table
    // (Schema.SchemaAnnotations.KeyedArrays).
    IReadOnlyList<string>? KeyMembers = null,

    // For 'struct': the Loqui/CLR class this struct is, as the schema declares it — null for every
    // other type. Read off the reflected type (Schema.ReflectedTypes.StructTypeName), so it is
    // structural, never per-game knowledge.
    //
    // Distinct from a discriminator's value, which says which class an *object* turned out to be:
    // an abstract union's element declares `Condition` here and answers `ConditionFloat` there.
    // Nothing else on the wire determines it — a struct that is not a union carries no
    // discriminator, and its member names are its shape, not its identity.
    string? LeafTypeName = null)
{
    /// <summary>Whether this field renders as a set of independent flags rather than one choice.
    /// Derived, not stored — a member's own <c>BitValue</c> is the only place that fact lives, so
    /// nothing can claim to be a bitmask over members that name no bit.
    ///
    /// <para>Off the wire for the same reason: the members are already there, and the webview asks
    /// them the same question (<c>flagBits</c>, modelValue.ts). Shipping the answer too would put a
    /// second copy of it on every field of every record.</para></summary>
    [JsonIgnore]
    public bool IsBitmask => EnumMember.IsBitmask(EnumMembers);
}

// Value contract: a bitmask field (Metadata.IsBitmask) carries its combined flags as a decimal
// string, not a number — so values above 2^53 survive JSON round-tripping without IEEE 754 loss.
public record FieldValue(FieldMetadata Metadata, object? Value, string? CheckError = null);

// RecordType: the schema table name (e.g. "NPC_") this record belongs to — needed by
// the webview's "Copy as New Record" column-header action, which must supply a RecordType up
// front to CreateRecord (schema validation happens before the TemplateFormKey is even read; see
// RecordEditService's create path). Defaults to "" for the many call sites (mostly
// test fixtures) that don't need it — always populated for real reads (ReadDetail knows its own
// schema's TableName).
// Origin (ADR-0036): the mod folder that provided this row's physical file, or a reserved
// PluginOrigin value — paired with Plugin, never encoded into it. Required: every
// construction (including a test fixture) must say which origin, not fall back to one silently.
// Declared before the two still-defaulted trailing fields only because C# requires a required
// parameter to precede any optional one — callers may still pass it by name in any position.
// IsPartialForm: this override's own record-header Partial Form flag
// (Schema.PartialFormFlag), independent of any field's own value — always false for a row whose
// record cannot carry one (the plugin header: a ModHeader has no such flag). Drives
// ConflictClassifier's field-exclusion rule and the compare grid's column dimming (CompareOverride
// below).
// IsPartialFormable: whether this record's own type could ever carry the flag at all —
// independent of IsPartialForm's current state. Lets the webview decide whether to render its own
// Partial Form toggle (PluginHeader.tsx) without hand-duplicating Source.ContainerChildFields'
// container-type table client-side.
public record RecordDetail(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    string Origin,
    string RecordType = "",
    bool IsPartialForm = false,
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

// Resolutions (ADR-0031): only populated for a scalar formKey-typed leaf, keyed by plugin like
// Values/CellStates — one entry per plugin whose cell holds a FormKey value. Never populated on a
// struct/array field's own FieldDiff (its Values aren't FormKey strings) and never aggregated up
// from Children — each leaf's signal is independent, so a dangling sibling can't hide a live
// hyperlink/affordance on the leaf next to it.
//
// ConflictAll: this node's own bottom-up conflict classification — this field/element's own
// CellStates folded with the same ConflictAll aggregate of every descendant (recursively), via the
// shared ConflictRules.Reduce/Escalate rules. Scoped to exactly this FieldDiff's subtree — distinct
// from ClassifyResult.ConflictAll (record-wide, drives the Plugins-tree badge), which is computed
// only from the top-level Diffs. Drives the compare
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

public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll);

public record PluginRecordTypeCount(string Type, int Count, string DisplayName);

public record FilterRequest(string Sql);
public record FilterResponse(string? Sql);

// CrashRepairOffers: every tracked plugin this same load found stale/missing against
// Modbench's own record — an interrupted compile's journal marker, or a binary that could not be
// read at all — surfaced the same structured-failures way Failures already is (ADR-0026), never a
// second endpoint or poller: the only way either condition can newly appear is a compile this
// process itself drives, or a process restart, both of which this load call already observes.
public record LoadOrderResponse(
    string Status, IReadOnlyList<PluginLoadFailure> Failures, IReadOnlyList<CrashRepairOffer> CrashRepairOffers);
// ADR-0044: Mod Management's snapshot — every physical plugin copy in the instance. InstanceRoot
// (ADR-0001) is the MO2 instance these mod folders belong to, what the index file is keyed
// on; it must be the instance rather than anything wider, because Origin is a mod folder *name*
// unique only within one. GameDirectory is where the backend resolves the forced masters from.
public record LoadOrderRequest(
    IReadOnlyList<LoadOrderPlugin> Plugins, string GameDirectory, string InstanceRoot, string GameRelease = "Fallout4");
// One copy of the snapshot: Origin (ADR-0036) is Mod Management's to resolve — the mod
// folder that provided the file, or a reserved value (PluginOrigin.DataDirectory / MO2's
// overwrite). Slot is the name's plugins.txt line index, null when no line names it. Enabled (the
// `*` prefix) and Winning (this copy is what the Mod override order resolves the name to) are
// nullable purely to make an omitted field detectable: a plain bool would bind a missing property
// to false, quietly making every copy non-participating, so nothing would win any FormKey and the
// conflict picture would be empty but well-formed. The endpoint rejects null (400) rather than
// choosing a value on the caller's behalf.
public record LoadOrderPlugin(string Name, string Path, string Origin, int? Slot, bool? Enabled, bool? Winning);

// Origin (ADR-0036): the mod folder that provided the source row's physical file, or a
// reserved PluginOrigin value — additive alongside Plugin, same shape as RecordDetail.Origin.
// GetReferences never filters by plugin, so this isn't a filter gap; without Origin here,
// two same-filename sources referencing the same target are indistinguishable in the result.
public record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId, string Origin);

public record HealthResponse(string Status);

// ADR-0041: one field edit on one plugin's copy of a record — the wire form of the single
// write path. Plugin and Origin travel as the compound identity ADR-0036 requires rather than a bare
// filename: a caller with only a filename is asking an ambiguous question the moment two mods ship a
// plugin of the same name.
//
// Value is a raw JsonElement, deliberately. A field's value is whatever its schema says it is — a
// number, a string, an enum name, or the entire JSON array/object of a complex field written
// atomically (CONTEXT.md's "Complex field") — so typing it here would mean re-declaring the
// reflected schema on the wire.
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

// ADR-0041: xEdit's "Copy as Override Into…" / "Copy as New Record Into…", on the
// same door the other lifecycle gestures use — the route's own {formKey} names the record being
// copied, so the two plugins involved travel as SourcePlugin/SourceOrigin and
// DestinationPlugin/DestinationOrigin (ADR-0036's compound identity, on both sides of the copy).

public record RecordCopyAsOverrideRequest(string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin);

public record RecordCopyAsOverrideResponse(bool Applied, string FormKey);

/// <summary><see cref="RequestedFormKey"/> null means auto-allocate the next free local FormID
/// (both-refs collision-safe, the same posture <see cref="RecordCreateRequest.FormKey"/> uses); non-null
/// is xEdit's typed-FormID path.</summary>
public record RecordCopyAsNewRecordRequest(
    string SourcePlugin, string SourceOrigin, string DestinationPlugin, string DestinationOrigin, string? RequestedFormKey);

public record RecordCopyAsNewRecordResponse(bool Applied, string SourceFormKey, string NewFormKey);
