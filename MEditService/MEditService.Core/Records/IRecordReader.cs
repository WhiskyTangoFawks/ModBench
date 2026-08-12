using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Session;

namespace MEditService.Core.Records;

public interface IRecordReader
{
    PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset);
    RecordDetail? GetRecord(string tableName, string formKey, string? plugin, bool winnerOnly);
    IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey);

    // origin defaulted (like GetPlacement's) so pre-existing single-origin callers keep compiling — #272 / ADR-0036.
    VmadData? GetVmad(string formKey, string plugin, string origin = PluginOrigin.DataDirectory);

    // Conditions (CTDA) for one plugin's copy of a record, grouped by owning field path, in stored
    // order. Empty when the record carries none. Reconstructs the neutral ParsedCondition the codec
    // produced at index time (ADR-0032). origin defaulted, same reasoning as GetVmad.
    IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin = PluginOrigin.DataDirectory);
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
    PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset);
    IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);

    // Phase 16 — worldspace tree reads (from the placement / cell_location side tables).
    // Returns every cell under the worldspace; a TopCell has null Block/Sub coordinates.
    IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey);
    PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset);
    CellReferences GetCellReferences(string plugin, string cellFormKey);

    // Phase 16.2 — a placed ref's structural parentage (which cell, persistent/temporary, position),
    // used by EditOrchestrator to stamp placement onto copy/delete changes. Null when not placed.
    // origin defaulted so pre-existing single-origin callers keep compiling — #272 / ADR-0036.
    PlacementRow? GetPlacement(string formKey, string plugin, string origin = PluginOrigin.DataDirectory);
}
