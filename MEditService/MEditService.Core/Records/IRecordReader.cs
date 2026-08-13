using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Session;

namespace MEditService.Core.Records;

public interface IRecordReader
{
    // origin (#296 / ADR-0036): nullable and independent of plugin, unlike GetWorldspaceCells'/
    // GetInteriorCells'/GetCellReferences' required origin — this one is a *filter*, like
    // DuckDbPendingChangeService.BuildFilter's origin, not an identity field: plugin itself is
    // optional here (browsing every plugin's records is a legitimate call), so origin defaults to
    // "no additional constraint" (trailing, like BuildFilter's own origin) rather than forcing every
    // existing plugin/search/limit/offset call site to change just to keep compiling.
    PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset, string? origin = null);
    // origin (#296 / ADR-0036, required): nullable — like plugin, since GetRecord(formKey) (the
    // global-winner lookup) legitimately supplies neither — but no default, so every call site must
    // say explicitly whether it has one rather than silently keeping the pre-#296 filename-only
    // behavior. Every call site that supplies a non-null plugin already has a concrete origin in
    // hand (GetRecordForPlugin, GetPluginRecordTypes's staged lookup), so this mirrors
    // GetVmad/GetConditions/GetPlacement's required-parameter precedent, not GetRecords' own
    // trailing-default filter.
    RecordDetail? GetRecord(string tableName, string formKey, string? plugin, string? origin, bool winnerOnly);
    IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey);

    // origin (#272 / ADR-0036, required since #275): the mod folder that provided this plugin's
    // physical file, or a reserved PluginOrigin value — paired with plugin, never encoded into it.
    VmadData? GetVmad(string formKey, string plugin, string origin);

    // Conditions (CTDA) for one plugin's copy of a record, grouped by owning field path, in stored
    // order. Empty when the record carries none. Reconstructs the neutral ParsedCondition the codec
    // produced at index time (ADR-0032). origin: same reasoning as GetVmad's.
    IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin);
    int CountRecordsForPlugin(string tableName, string plugin);
    string? FindRecordType(string formKey);

    // O(1) form_key -> (record type, EditorID) lookup against the winning override, backed by the
    // form_lookup index-time table (ADR-0031). Prefer this over FindRecordType for any resolution
    // that runs per FormKey value in a hot response path (CheckErrorBuilder, FieldDiff/PendingChange/
    // VmadPropertyDiff resolution) — FindRecordType's per-table scan stays only for callers that
    // already have a table name and merely need existence (e.g. reference validation at stage time).
    RecordLookupEntry? ResolveFormKey(string formKey);

    // Form keys of records native to the plugin (the FormKey's own ModKey == plugin), across all
    // real record tables. Used for ESL-eligibility validation (issue #85).
    IReadOnlyList<string> GetNativeFormKeys(string plugin);
    // origin: same nullable-filter reasoning as GetRecords' above.
    PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset, string? origin = null);
    IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    // Phase 16 — worldspace tree reads (from the placement / cell_location side tables).
    // Returns every cell under the worldspace; a TopCell has null Block/Sub coordinates.
    // origin (#296 / ADR-0036, required): the mod folder that provided this plugin's physical
    // file, or a reserved PluginOrigin value — plugin here is never optional (every caller is
    // already scoped to one specific plugin), so unlike GetRecords'/SearchRecords' origin filter,
    // this one is required rather than defaulted, matching GetVmad/GetConditions/GetPlacement.
    IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey, string origin);
    PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string origin);
    CellReferences GetCellReferences(string plugin, string cellFormKey, string origin);

    // Phase 16.2 — a placed ref's structural parentage (which cell, persistent/temporary, position),
    // used by EditOrchestrator to stamp placement onto copy/delete changes. Null when not placed.
    // origin: same reasoning as GetVmad's (#272 / ADR-0036, required since #275).
    PlacementRow? GetPlacement(string formKey, string plugin, string origin);
}
