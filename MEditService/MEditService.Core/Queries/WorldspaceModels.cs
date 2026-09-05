namespace MEditService.Core.Queries;

// DTOs for the per-plugin worldspace / cell / placed-object tree.

// HasParseFailure on every node of this tree means the same thing it means on a record row:
// this row, or something the tree shows under it, could not be read.
public record WorldspaceSummary(string FormKey, string? EditorId, bool HasParseFailure = false);

// IsPersistentWorldspaceCell is the cell a Worldspace's TopCell slot names (xEdit's "<Persistent
// Worldspace Cell>"). FullName stays a separate fact: xEdit's GetDisplayName checks FULL first,
// unconditionally, so the tree provider needs both. Trailing so positional constructions compile.
public record CellSummary(
    string FormKey, string? EditorId, int? CellX, int? CellY,
    bool IsPersistentWorldspaceCell = false, string? FullName = null, bool HasParseFailure = false);

public record PlacedSummary(
    string FormKey, string? EditorId, string? BaseFormKey, string RecordType, bool HasParseFailure = false);

public record CellReferences(
    IReadOnlyList<PlacedSummary> Persistent,
    IReadOnlyList<PlacedSummary> Temporary);

public record WorldspaceSubBlockDto(
    int X, int Y, IReadOnlyList<CellSummary> Cells, bool HasParseFailure = false);

public record WorldspaceBlockDto(
    int X, int Y, IReadOnlyList<WorldspaceSubBlockDto> SubBlocks, bool HasParseFailure = false);

// TopCells is a list: a worldspace should have one block-less cell row, but every one found is
// surfaced rather than silently discarded. Only the first carries IsPersistentWorldspaceCell.
public record WorldspaceBlocks(IReadOnlyList<WorldspaceBlockDto> Blocks, IReadOnlyList<CellSummary> TopCells);

// Flat row for cells under a worldspace; BlockX/Y and SubX/Y are null for a TopCell. FullName
// trails so positional constructions keep compiling.
public record CellLocationSummary(
    string FormKey, string? EditorId,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? CellX, int? CellY,
    string? FullName = null, bool HasParseFailure = false);
