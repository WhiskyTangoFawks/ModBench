using MEditService.Core.Records;

namespace MEditService.Core.Queries;

// DTOs for the per-plugin worldspace / cell / placed-object tree.

// HasParseFailure on every node of this tree means the same thing it means on a record row:
// this row, or something the tree shows under it, could not be read.
public record WorldspaceSummary(string FormKey, string? EditorId, bool HasParseFailure = false);

public record WorldspaceSubBlockDto(
    int X, int Y, IReadOnlyList<CellSummary> Cells, bool HasParseFailure = false);

public record WorldspaceBlockDto(
    int X, int Y, IReadOnlyList<WorldspaceSubBlockDto> SubBlocks, bool HasParseFailure = false);

// TopCells is a list: a worldspace should have one block-less cell row, but every one found is
// surfaced rather than silently discarded. Only the first carries IsPersistentWorldspaceCell.
public record WorldspaceBlocks(IReadOnlyList<WorldspaceBlockDto> Blocks, IReadOnlyList<CellSummary> TopCells);
