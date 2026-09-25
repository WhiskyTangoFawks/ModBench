namespace MEditService.Index;

// Flat row for a cell in its blocks. BlockX/Y and SubX/Y are null for a worldspace's TopCell; an
// interior cell's block and sub-block are one number each, in BlockX and SubX.
public record CellLocationSummary(
    string FormKey, string? EditorId,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? CellX, int? CellY,
    string? FullName = null, bool HasParseFailure = false, string? ParseDiagnosis = null, bool HasChildren = false);
