namespace MEditService.Index.Queries;

// IsPersistentWorldspaceCell is the cell a Worldspace's TopCell slot names (xEdit's "<Persistent
// Worldspace Cell>"). FullName stays a separate fact: xEdit's GetDisplayName checks FULL first,
// unconditionally, so the tree provider needs both.
public record CellSummary(
    string FormKey, string? EditorId, int? CellX, int? CellY, WorkingTreeState WorkingTreeState,
    bool IsPersistentWorldspaceCell = false, string? FullName = null, bool HasParseFailure = false,
    string? ParseDiagnosis = null, bool HasChildren = false);
