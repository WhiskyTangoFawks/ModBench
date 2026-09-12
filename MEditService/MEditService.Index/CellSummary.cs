namespace MEditService.Index;

// IsPersistentWorldspaceCell is the cell a Worldspace's TopCell slot names (xEdit's "<Persistent
// Worldspace Cell>"). FullName stays a separate fact: xEdit's GetDisplayName checks FULL first,
// unconditionally, so the tree provider needs both. Trailing so positional constructions compile.
public record CellSummary(
    string FormKey, string? EditorId, int? CellX, int? CellY,
    bool IsPersistentWorldspaceCell = false, string? FullName = null, bool HasParseFailure = false);
