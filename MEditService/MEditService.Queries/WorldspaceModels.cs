namespace MEditService.Queries;

// DTOs for the per-plugin worldspace / cell / placed-object tree.

// HasParseFailure on every node of this tree means the same thing it means on a record row:
// this row, or something the tree shows under it, could not be read. HasChildren is whether it
// holds a cell.
public record WorldspaceSummary(
    string FormKey, string? EditorId, WorkingTreeState WorkingTreeState, bool HasParseFailure = false, string? FullName = null,
    string? ParseDiagnosis = null, bool HasChildren = false);

public record WorldspaceSubBlockDto(
    int X, int Y, IReadOnlyList<CellSummary> Cells, bool HasParseFailure = false);

public record WorldspaceBlockDto(
    int X, int Y, IReadOnlyList<WorldspaceSubBlockDto> SubBlocks, bool HasParseFailure = false);

// TopCells is a list: a worldspace should have one block-less cell row, but every one found is
// surfaced rather than silently discarded. Only the first carries IsPersistentWorldspaceCell.
public record WorldspaceBlocks(IReadOnlyList<WorldspaceBlockDto> Blocks, IReadOnlyList<CellSummary> TopCells);

// xEdit numbers an interior cell's block and sub-block with one number each.
public record InteriorCellSubBlock(int Number, IReadOnlyList<CellSummary> Cells, bool HasParseFailure = false);

public record InteriorCellBlock(int Number, IReadOnlyList<InteriorCellSubBlock> SubBlocks, bool HasParseFailure = false);
