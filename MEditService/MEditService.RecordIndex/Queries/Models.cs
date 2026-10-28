using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.RecordIndex.Queries;

// One Kind B diagnosis. Text is PluginDiagnosis.Describe()'s exact refusal fragment, so the
// Problems panel and the init refusal share one vocabulary.
public record PluginDiagnosisReport(string Plugin, string Origin, string Text);

/// <summary>One plugin row as the wire shows it: the load order's facts, what reading the file told the Index, and
/// what a filter, a parse failure and the rows' own derivation add.</summary>
public sealed record PluginResponse(
    string Name,
    string Path,
    // The load index (ADR-0013), null when the plugin is not active.
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    // IsBlueprint (plugins.md, Drag and drop, story 3): a blueprint plugin loads after every plugin
    // that is not one. False for every plugin of a game without blueprint plugins.
    bool IsBlueprint,
    IReadOnlyList<string> Masters,
    bool IsImmutable,
    string Origin,
    // MissingMasters (ADR-0012): the masters in this plugin's header that are not active.
    // Null while the snapshot is not indexed: not yet checked, which is not no issues.
    IReadOnlyList<string>? MissingMasters,
    // LateMasters: the active masters in this plugin's header that load after it. Null as MissingMasters is.
    IReadOnlyList<string>? LateMasters,
    bool InLoadOrder,
    // HasMatchingRecords (plugins.md): a record filter prunes records, never a
    // plugin row, so this is what a caller uses to decide whether to offer a chevron.
    bool HasMatchingRecords,
    // IsCompiledPlugin (ADR-0007): its mod was a source mod when the Index last read it. False with no mod folder
    // at all (IsImmutable tells the two apart).
    bool IsCompiledPlugin,
    // HasParseFailure: whether this plugin holds a record Mutagen could not read. The plugin-level
    // load failure (LoadOrderResponse.Failures) stays its own channel for a file that never indexed.
    bool HasParseFailure,
    // plugins.md, A row, Plugin: compiled plugin, and its records are its plugin file's because its plugin
    // source is missing or cannot be read. Null when the plugin source reads.
    UnreadableSource? PluginSourceUnreadable,
    // common.md, States, story 6: the files that stopped its last read, while its rows are the last good read's.
    IReadOnlyList<SourceProblem>? LaterReadFailure);

public record RecordDetail(
    string FormKey,
    string Plugin,
    // The column order conflict classification reads; the front end reads LoadIndex instead.
    [property: JsonIgnore] int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    // Origin (ADR-0012), paired with Plugin, never encoded into it. Required so every construction
    // says which origin; it precedes the defaulted fields only because C# requires that.
    string Origin,
    // The schema table name; "Copy as New Record" must supply it to CreateRecord up front.
    string RecordType,
    // The record header's Partial Form flag, independent of any field value; always false for a
    // record that cannot carry one (the plugin header). Drives field exclusion and column dimming.
    bool IsPartialForm = false,
    // Non-null when ingest could not produce this record's document, so Fields are the stub's.
    // The record editor renders the column read-only with this as the reason; every write is
    // refused.
    string? ParseDiagnosis = null,
    // The strings file this copy's plugin looked for and did not find; reads into each translated
    // text's check error, never onto the wire as a field of its own.
    [property: JsonIgnore] string? MissingStringsFile = null);

public record CompareOverride(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    ConflictThis? ConflictThis,
    string Origin,
    // xEdit's load index, as the column header's label shows it: `0A`, or `FE:001` for a light plugin.
    // Null for a plugin that is not active: it has no load index.
    string? LoadIndex,
    string RecordType,
    bool IsPartialForm = false,
    string? ParseDiagnosis = null,
    // Overwrite (ADR-0012), computed here from what provides the plugin so the webview
    // never interprets Origin itself.
    bool IsInOverwrite = false,
    // The key this copy's cells carry in each FieldDiff map when it is not the plugin's own
    // ColumnKey: several records compared may hold two copies from one plugin.
    string? Column = null,
    string? MissingStringsFile = null)
    : RecordDetail(
        FormKey, Plugin, LoadOrderIndex, IsWinner, EditorId, Fields, Origin, RecordType, IsPartialForm,
        ParseDiagnosis, MissingStringsFile);

public record FieldDiff(
    string FieldName,
    Dictionary<string, object?> Values,
    string WinnerColumn,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    // This subtree's own aggregate, distinct from the record-wide ClassifyResult.ConflictAll; drives
    // the compare grid's per-row background (ADR-0018): a struct's aggregate while collapsed.
    ConflictAll ConflictAll,
    IReadOnlyList<FieldDiff>? Children = null,
    // Only on a scalar formKey leaf (ADR-0005), keyed like Values; never aggregated up from Children,
    // so a dangling sibling can't hide a live hyperlink on the leaf next to it.
    IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null,
    // This node's own subtree's link check, per column — a struct row states the errors under it
    // rather than the whole record's, which FieldValue.CheckError on the root field states.
    IReadOnlyDictionary<string, string>? CheckErrors = null,
    // An array element's own index in each column's array that holds it; null on any other node.
    IReadOnlyDictionary<string, int>? Indexes = null,
    // Only in a comparison of several records: each cell's state when each column is the focused
    // one, keyed by the focused column and then the cell's column. The panel picks the entry for the
    // column it has focused.
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, ConflictThis>>? CellStatesByFocus = null);

internal sealed record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

/// <summary>A comparison, and the language a translated text shows in.</summary>
public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll,
    string RecordTypeName,
    string StringsLanguage);

/// <summary>One column of a comparison of several records: the copy <paramref name="Plugin"/> holds,
/// or the one <paramref name="DocumentText"/> spells in its place (ADR-0012).</summary>
public record RecordCopy(string FormKey, PluginAddress Plugin, string? DocumentText = null);

/// <summary>The document carrying the record, its own or its container's, that a comparison reads
/// <paramref name="Plugin"/>'s copy from in place of the record index's copy. <paramref name="Alone"/>
/// compares that copy with no other.</summary>
public record CopyText(PluginAddress Plugin, string DocumentText, bool Alone = false);

public record RenderedDocument(string FileName, string Text);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CopyDocumentKind { OwnFile, ContainersFile, Rendered }

/// <summary>Where a copy is a document: <paramref name="Location"/> is the path of its own file, of the
/// file of the record carrying it, or the name of its rendered document, as <paramref name="Kind"/> says.</summary>
public record CopyDocument(CopyDocumentKind Kind, string Location);

// ADR-0012.
public record ReferenceResult(
    string FormKey, string Plugin, string Origin, string FieldPath, string RecordType, string RecordTypeName, string? EditorId);

// HasParseFailure: whether this subtree holds a record Mutagen could not read, so the tree renders
// the failure prefix instead of walking children. IsCreatable: RecordTypes' verdict.
// IsContainer: the type holds child records in the game; an empty one counts.
public record PluginRecordTypeCount(
    string Type, int Count, string DisplayName, bool HasParseFailure, bool IsCreatable, bool IsContainer);

public record RecordTypeChoice(string Type, string DisplayName);

/// <summary>The answer to "did the projection reach at least N?" (ADR-0015). Sequence
/// is the value observed at the moment of that answer, not necessarily equal to the awaited
/// bound.</summary>
public record SequenceAwaitResponse(bool Reached, long Sequence);

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);

public record CellChildRecords(
    IReadOnlyList<ChildRecordSummary> Persistent,
    IReadOnlyList<ChildRecordSummary> Temporary);

public record ChildRecordSummary(
    string FormKey, string? EditorId, string? BaseFormKey, string RecordType, WorkingTreeState WorkingTreeState,
    bool HasParseFailure = false, string? FullName = null, string? BaseEditorId = null, string? ParseDiagnosis = null);

/// <summary><see cref="RecordGone"/> when no registered plugin holds the record at all, otherwise only the
/// plugin the copy names lacks it.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CopyMissingReason { RecordGone, NotInPlugin }

/// <summary>A copy of the comparison that no plugin gave.</summary>
public sealed record CopyMissing(string FormKey, PluginAddress Plugin, CopyMissingReason Reason, string Message);

// ADR-0012.
public record RecordSummary(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    string Origin,
    WorkingTreeState WorkingTreeState = WorkingTreeState.None,
    // Whether this FormKey holds at least one container child: the Plugins tree's
    // expand chevron for a qust/dial row.
    bool HasContainerChildren = false,
    // Non-null when ingest could not turn this record into its document, so a listing never omits
    // one silently.
    string? ParseDiagnosis = null,
    // The same fact widened to this row's subtree, so the tree never walks children to aggregate.
    bool HasParseFailure = false,
    string? FullName = null);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ConflictAll
{
    OnlyOne,
    NoConflict,
    Override,
    Conflict,
    ConflictBenign,
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ConflictThis
{
    OnlyOne,
    Master,
    IdenticalToMaster,
    Override,
    ConflictWins,
    ConflictLoses,
}

// Container-type-agnostic by design: only Quest/DialogTopic are wired to it; Cell/Worldspace keep
// their own worldspace-tree surface.

/// <summary>One child record of a container, in xEdit's presentation order. RecordType is the raw
/// signature ("dial", "dlbr", "scen", "info") the frontend needs to know a returned Dialog Topic
/// is itself expandable.</summary>
public record ContainerChildSummary(
    string FormKey, string? EditorId, string Plugin, string Origin,
    int LoadOrderIndex, bool IsWinner, WorkingTreeState WorkingTreeState, string RecordType,
    // A returned "dial" child is itself a container the Plugins tree recurses into, so it needs
    // the same presence fact for its own expand chevron.
    bool HasContainerChildren = false,
    // The same pair every record row carries: this child's own diagnosis, and the fact widened to
    // its own children so the tree renders the failure prefix without walking them.
    string? ParseDiagnosis = null,
    bool HasParseFailure = false,
    string? FullName = null,
    // The child's type holds child records in the game, whether or not this one holds any.
    bool IsContainer = false);

// DTOs for the per-plugin worldspace / cell / placed-object tree.

// HasParseFailure on every node of this tree means the same thing it means on a record row:
// this row, or something the tree shows under it, could not be read. HasChildren is whether it
// holds a cell.
public record WorldspaceSummary(
    string FormKey, string? EditorId, WorkingTreeState WorkingTreeState, bool HasParseFailure = false, string? FullName = null,
    string? ParseDiagnosis = null, bool HasChildren = false);

public record WorldspaceSubBlockDto(
    int X, int Y, IReadOnlyList<CellSummary> Cells, bool HasParseFailure = false);

public record WorldspaceBlockDto(
    int X, int Y, IReadOnlyList<WorldspaceSubBlockDto> SubBlocks, bool HasParseFailure = false);

public record WorldspaceBlocks(IReadOnlyList<WorldspaceBlockDto> Blocks, IReadOnlyList<CellSummary> TopCells);

// xEdit numbers an interior cell's block and sub-block with one number each.
public record InteriorCellSubBlock(int Number, IReadOnlyList<CellSummary> Cells, bool HasParseFailure = false);

public record InteriorCellBlock(int Number, IReadOnlyList<InteriorCellSubBlock> SubBlocks, bool HasParseFailure = false);

// IsPersistentWorldspaceCell is the cell a Worldspace's TopCell slot names (xEdit's "<Persistent
// Worldspace Cell>"). FullName stays a separate fact: xEdit's GetDisplayName checks FULL first,
// unconditionally, so the tree provider needs both.
public record CellSummary(
    string FormKey, string? EditorId, int? CellX, int? CellY, WorkingTreeState WorkingTreeState,
    bool IsPersistentWorldspaceCell = false, string? FullName = null, bool HasParseFailure = false,
    string? ParseDiagnosis = null, bool HasChildren = false);

/// <summary>Why a store rebuild did nothing (ADR-0010, ADR-0019).</summary>
public enum StoreRebuildRefusal
{
    HeldByAnotherWindow,
    StillServingReads,
}

public sealed record StoreRebuildRefused(StoreRebuildRefusal Refusal, string Message);

/// <summary>Why a read or a filter of the Index answered nothing (ADR-0019).</summary>
public enum IndexRefusal
{
    NoLoadOrder,
    IndexNotReady,
    FilterRejected,
    SelectRejected,
    NameRefused,
    SourceStopped,
    OutOfMemory,
}

public record IndexRefused(IndexRefusal Refusal, string Message);

/// <summary>A name as a person gives it: a plugin's file name, a record's EditorID or FormKey. An origin
/// names a plugin and picks among those that share a file name.</summary>
public sealed record NameQuery(string Name, string? Origin = null);

/// <summary>Each row of a SELECT, a JSON object of its columns.</summary>
public sealed record SelectedRows(JsonElement[] Rows);

/// <summary>What one name means: a plugin, or a record by its FormKey.</summary>
public sealed record NamedObject(PluginAddress? Plugin, string? FormKey, string? EditorId);

/// <summary>The comparison of every copy given, or, with any copy missing, the copies no plugin gave, in the
/// order given (ADR-0019): <c>Compare</c> is null exactly when <c>Missing</c> is not empty.</summary>
public sealed record CompareRecordsAnswer(CompareResult? Compare, IReadOnlyList<CopyMissing> Missing)
{
    internal static CompareRecordsAnswer Compared(CompareResult compare) => new(compare, []);

    internal static CompareRecordsAnswer CopiesMissing(IReadOnlyList<CopyMissing> missing) => new(null, missing);
}

// A tri-state rather than two booleans: the states are mutually exclusive. Deleted is absent
// because a working-tree-deleted record has no row to describe.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WorkingTreeState { None, Modified, Added }

/// <summary>The working-tree states beneath each tree row that has any, under the record filter
/// (common.md, story 11). A record's own state is on its listing; a block holds what its cells
/// hold.</summary>
public record WorkingTreeStatesBeneath(
    IReadOnlyList<WorkingTreeState> Plugin,
    IReadOnlyDictionary<string, IReadOnlyList<WorkingTreeState>> RecordTypes,
    IReadOnlyDictionary<string, IReadOnlyList<WorkingTreeState>> Records);

/// <summary>What is wrong in a plugin's source, on its file: a link at <paramref name="FieldPath"/> to
/// <paramref name="TargetFormKey"/>, which neither it nor an active plugin holds, or a file the read stopped at.</summary>
public sealed record SourceProblem(
    string? FormKey, string? TargetFormKey, string? FieldPath, string SourceRelativePath, string Message)
{
    internal static SourceProblem StoppedAt(SourceFileFailure failure) =>
        new(failure.FormKey, null, null, failure.SourceRelativePath, failure.Message);
}

/// <summary>Why a plugin's <see cref="PluginProblems.Problems"/> are not a clean bill (ADR-0019).</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ProblemsFailureKind
{
    /// <summary>Its links could not be placed on files; mEdit does not log this.</summary>
    Placement,
    /// <summary>Its rows are the last good read's; mEdit logs this once when it begins.</summary>
    LaterRead,
}

/// <summary><paramref name="Failure"/> and its <paramref name="FailureKind"/> are set when the plugin's
/// <paramref name="Problems"/> are not a clean bill (ADR-0019).</summary>
public sealed record PluginProblems(
    PluginAddress Plugin, IReadOnlyList<SourceProblem> Problems, string? Failure = null, ProblemsFailureKind? FailureKind = null);

/// <summary>The plugins whose masters list a plugin's file name, and those whose masters mEdit could not
/// read and so may.</summary>
public sealed record PluginDependants(IReadOnlyList<PluginAddress> Dependants, IReadOnlyList<PluginAddress> Unreadable);

/// <summary>Whether the record index's rows for a plugin are of the file now on disk (ADR-0003), not yet, or its read failed.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum PluginIndexing { AsOnDisk, NotYet, ReadFailed }

/// <summary><paramref name="Reason"/> is mEdit's, and set only when the read failed (ADR-0019).</summary>
public sealed record PluginIndexedState(PluginIndexing State, string? Reason = null);

/// <summary>The record filter in force: the SQL that narrows the listings, and the file or document it was written in.</summary>
public sealed record RecordFilter(string Sql, string Source);
