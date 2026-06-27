namespace MEditService.Core.Queries;

// Phase 16: DTOs for the per-plugin worldspace / cell / placed-object tree.

public record WorldspaceSummary(string FormKey, string? EditorId);

public record CellSummary(string FormKey, string? EditorId, int? CellX, int? CellY);

public record PlacedSummary(string FormKey, string? EditorId, string? BaseFormKey, string RecordType);

public record CellReferences(
    IReadOnlyList<PlacedSummary> Persistent,
    IReadOnlyList<PlacedSummary> Temporary);

public record WorldspaceSubBlockDto(int X, int Y, IReadOnlyList<CellSummary> Cells);

public record WorldspaceBlockDto(int X, int Y, IReadOnlyList<WorldspaceSubBlockDto> SubBlocks);

public record WorldspaceBlocks(IReadOnlyList<WorldspaceBlockDto> Blocks, CellSummary? TopCell);

// Flat row returned by the repository for cells under a worldspace; the query service groups
// these into blocks/sub-blocks. BlockX/Y and SubX/Y are null for a worldspace's TopCell.
public record CellLocationSummary(
    string FormKey, string? EditorId,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? CellX, int? CellY);
