using System.Text.Json.Serialization;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;

namespace MEditService.Queries;

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

/// <summary>One plugin row as the read side answers it: the load order's facts, what reading the file
/// told the Index, and what a filter, a parse failure and the rows' own derivation add.</summary>
public sealed record PluginRow(
    RegisteredPlugin Plugin,
    // LoadOrderIndex (ADR-0013), null when the plugin is not active.
    int? LoadOrderIndex,
    bool IsImmutable,
    PluginContent Content,
    // MasterIssues (ADR-0012): the masters in this plugin's header that are not active.
    // Null while the snapshot is not indexed: not yet checked, which is not no issues.
    IReadOnlyList<string>? MasterIssues,
    // HasMatchingRecords (plugins.md): a record filter prunes records, never a plugin row, so this
    // is what a caller uses to decide whether to offer a chevron.
    bool HasMatchingRecords,
    // HasParseFailure: whether this plugin holds a record Mutagen could not read. The plugin-level
    // load failure (LoadOrderResponse.Failures) stays its own channel for a file that never indexed.
    bool HasParseFailure,
    // IsTracked (ADR-0007), as the Index holds it. Whether a .git is on disk now is the Source
    // adapter's.
    bool IsTracked);

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
    // The schema table name; "Copy as New Record" must supply it to CreateRecord up front. Defaults
    // to "" for test fixtures — always populated for real reads.
    string RecordType = "",
    // The record header's Partial Form flag, independent of any field value; always false for a
    // record that cannot carry one (the plugin header). Drives field exclusion and column dimming.
    bool IsPartialForm = false,
    // Non-null when ingest could not produce this record's document, so Fields are the stub's.
    // The record editor renders the column read-only with this as the reason; every write is
    // refused.
    string? ParseDiagnosis = null);

public record CompareOverride(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    ConflictThis? ConflictThis,
    string Origin,
    // xEdit's load index, as the column header's label shows it: `0A`, or `FE 001` for a light plugin.
    string LoadIndex,
    string RecordType = "",
    bool IsPartialForm = false,
    string? ParseDiagnosis = null,
    // Overwrite (ADR-0012), computed here (PluginOrigin.IsOverwrite) so the webview
    // never interprets Origin itself.
    bool IsInOverwrite = false)
    : RecordDetail(
        FormKey, Plugin, LoadOrderIndex, IsWinner, EditorId, Fields, Origin, RecordType, IsPartialForm,
        ParseDiagnosis);

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
    IReadOnlyDictionary<string, int>? Indexes = null);

public record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll,
    string RecordTypeName);

// ADR-0012.
public record ReferenceResult(
    string FormKey, string Plugin, string Origin, string FieldPath, string RecordType, string RecordTypeName, string? EditorId);

// HasParseFailure: whether this subtree holds a record Mutagen could not read, so the tree renders
// the failure prefix instead of walking children. IsCreatable: CreatableRecordTypes' own verdict.
public record PluginRecordTypeCount(string Type, int Count, string DisplayName, bool HasParseFailure, bool IsCreatable);

public record CreatableRecordType(string Type, string DisplayName);

/// <summary>The answer to "did the projection reach at least N?" (ADR-0015). Sequence
/// is the value observed at the moment of that answer, not necessarily equal to the awaited
/// bound.</summary>
public record SequenceAwaitResponse(bool Reached, long Sequence);
