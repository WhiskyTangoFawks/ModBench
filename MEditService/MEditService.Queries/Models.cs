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

/// <summary>One plugin row as the read side answers it: the load order's copy, what reading the file
/// told the Index, and what a filter and a parse failure add. Tracked is the repository's
/// answer.</summary>
public sealed record PluginRow(
    RegisteredCopy Copy,
    PluginContent Content,
    // MasterIssues (ADR-0012): this plugin's own unresolvable masters, never a transitive fact.
    // Empty rather than null when every master resolved.
    IReadOnlyList<MasterIssue> MasterIssues,
    // HasMatchingRecords (plugins.md): a record filter prunes records, never a plugin row, so this
    // is what a caller uses to decide whether to offer a chevron.
    bool HasMatchingRecords,
    // HasParseFailure: whether this plugin holds a record Mutagen could not read. The plugin-level
    // load failure (LoadOrderResponse.Failures) stays its own channel for a file that never indexed.
    bool HasParseFailure);

public record RecordDetail(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    // Origin (ADR-0012): paired with Plugin, never encoded into it. Required so every construction
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
    bool IsPartialFormable = false,
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
    ConflictThis ConflictThis,
    string Origin,
    string RecordType = "",
    bool IsPartialForm = false,
    bool IsPartialFormable = false,
    string? ParseDiagnosis = null)
    : RecordDetail(
        FormKey, Plugin, LoadOrderIndex, IsWinner, EditorId, Fields, Origin, RecordType, IsPartialForm,
        IsPartialFormable, ParseDiagnosis);

public record FieldDiff(
    string FieldName,
    [property: ColumnKeyed] Dictionary<string, object?> Values,
    string WinnerColumn,
    [property: ColumnKeyed] IReadOnlyDictionary<string, ConflictThis> CellStates,
    // This subtree's own aggregate, distinct from the record-wide ClassifyResult.ConflictAll; drives
    // the compare grid's per-row background (ADR-0018): a struct's aggregate while collapsed.
    ConflictAll ConflictAll,
    IReadOnlyList<FieldDiff>? Children = null,
    // ADR-0005: only on a scalar formKey leaf, keyed like Values; never aggregated up from Children,
    // so a dangling sibling can't hide a live hyperlink on the leaf next to it.
    [property: ColumnKeyed] IReadOnlyDictionary<string, FormKeyResolution>? Resolutions = null,
    // This node's own subtree's link check, per column — a struct row states the errors under it
    // rather than the whole record's, which FieldValue.CheckError on the root field states.
    [property: ColumnKeyed] IReadOnlyDictionary<string, string>? CheckErrors = null);

public record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll);

// HasParseFailure: whether this subtree holds a record Mutagen could not read, so the tree renders
// the failure prefix from the page it has instead of walking children.
public record PluginRecordTypeCount(string Type, int Count, string DisplayName, bool HasParseFailure);
