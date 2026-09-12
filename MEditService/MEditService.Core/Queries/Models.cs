using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
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
    // ADR-0013: the plugins.txt slot past the forced masters, or null when no line names this
    // copy; record-level LoadOrderIndex values are sort keys and put such a copy last.
    int? LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable,
    // Participates (ADR-0013): Registration.Participates, as the wire sees it — the only copies
    // that compete for winner or count in a conflict.
    bool Participates,
    string Origin,
    // MasterIssues (ADR-0012): this plugin's own unresolvable masters, never a transitive fact.
    // Empty rather than null when every master resolved.
    IReadOnlyList<MasterIssue> MasterIssues,
    // InLoadOrder (ADR-0013, ADR-0013): derived — the winning copy of a listed name, enabled
    // or not. False for a losing copy or an unlisted file. See PluginMetadata.InLoadOrder.
    bool InLoadOrder,
    // Enabled / Winning (ADR-0013): the two registration facts beside the slot, as Mod Management
    // stated them — what lets a row say *why* it does not participate (disabled, or overridden).
    bool Enabled,
    bool Winning,
    // HasMatchingRecords (plugins.md): a record filter prunes records, never a
    // plugin row, so this is what a caller uses to decide whether to offer a chevron. Defaults
    // to true: only the plugin listing answers inside a filter.
    bool HasMatchingRecords = true,
    // IsTracked (ADR-0007): whether the mod folder holds a git directory, which editing requires
    // and viewing never does. False with no mod folder at all (IsImmutable tells the two apart).
    // Derived on every read: the directory can vanish outside Modbench.
    bool IsTracked = false,
    // HasParseFailure: whether this plugin holds a record Mutagen could not read. The plugin-level
    // load failure (LoadOrderResponse.Failures) stays its own channel for a file that never indexed.
    bool HasParseFailure = false)
{
    /// <summary>One row: its registration from the load order's copy, what reading the file told
    /// the Index from <paramref name="content"/> (ADR-0013).</summary>
    public static PluginResponse Of(
        RegisteredCopy copy, PluginContent content, IReadOnlyList<MasterIssue>? masterIssues = null,
        bool hasMatchingRecords = true, bool hasParseFailure = false)
    {
        var registration = copy.Registration;
        return new(copy.Name, copy.Path, copy.Slot, content.IsLight, content.IsMaster, content.Masters,
            content.RecordCount, copy.IsImmutable, registration.Participates, copy.Origin,
            masterIssues ?? [], registration.InLoadOrder, copy.Enabled, copy.Winning, hasMatchingRecords,
            SourceRepository.IsEditable(copy.Origin, copy.Path), hasParseFailure);
    }
}

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
