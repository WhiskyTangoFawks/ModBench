namespace MEditService.Index;

// Flat row for cells under a worldspace; BlockX/Y and SubX/Y are null for a TopCell. FullName
// trails so positional constructions keep compiling.
public record CellLocationSummary(
    string FormKey, string? EditorId,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? CellX, int? CellY,
    string? FullName = null, bool HasParseFailure = false);
