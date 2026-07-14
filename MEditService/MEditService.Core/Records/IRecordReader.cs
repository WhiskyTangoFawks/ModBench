using MEditService.Core.Queries;

namespace MEditService.Core.Records;

public interface IRecordReader
{
    PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset);
    RecordDetail? GetRecord(string tableName, string formKey, string? plugin, bool winnerOnly);
    IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey);
    VmadData? GetVmad(string formKey, string plugin);
    int CountRecordsForPlugin(string tableName, string plugin);
    string? FindRecordType(string formKey);

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
    PlacementRow? GetPlacement(string formKey, string plugin);
}
