namespace MEditService.Core.Queries;

// DTOs for the per-plugin worldspace / cell / placed-object tree.

public record WorldspaceSummary(string FormKey, string? EditorId);

// IsPersistentWorldspaceCell is the cell a Worldspace's TopCell slot names (xEdit's "<Persistent
// Worldspace Cell>"). FullName stays a separate fact: xEdit's GetDisplayName checks FULL first,
// unconditionally, so the tree provider needs both. Trailing so positional constructions compile.
public record CellSummary(
    string FormKey, string? EditorId, int? CellX, int? CellY,
    bool IsPersistentWorldspaceCell = false, string? FullName = null);

public record PlacedSummary(string FormKey, string? EditorId, string? BaseFormKey, string RecordType);

public record CellReferences(
    IReadOnlyList<PlacedSummary> Persistent,
    IReadOnlyList<PlacedSummary> Temporary);

public record WorldspaceSubBlockDto(int X, int Y, IReadOnlyList<CellSummary> Cells);

public record WorldspaceBlockDto(int X, int Y, IReadOnlyList<WorldspaceSubBlockDto> SubBlocks);

// TopCells is a list: a worldspace should have one block-less cell row, but every one found is
// surfaced rather than silently discarded. Only the first carries IsPersistentWorldspaceCell.
public record WorldspaceBlocks(IReadOnlyList<WorldspaceBlockDto> Blocks, IReadOnlyList<CellSummary> TopCells);

// Flat row for cells under a worldspace; BlockX/Y and SubX/Y are null for a TopCell. FullName
// trails so positional constructions keep compiling.
public record CellLocationSummary(
    string FormKey, string? EditorId,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? CellX, int? CellY,
    string? FullName = null);
