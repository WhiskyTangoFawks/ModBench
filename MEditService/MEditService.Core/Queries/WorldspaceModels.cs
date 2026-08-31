namespace MEditService.Core.Queries;

// DTOs for the per-plugin worldspace / cell / placed-object tree.

public record WorldspaceSummary(string FormKey, string? EditorId);

// #251: IsPersistentWorldspaceCell — true for the single cell a Worldspace's own TopCell slot
// names (xEdit's "<Persistent Worldspace Cell>"), so the tree provider's label derivation doesn't
// have to infer it from which field of WorldspaceBlocks a cell arrived in.
// #497: FullName — the CELL record's own FULL name, independent of IsPersistentWorldspaceCell.
// xEdit's TwbMainRecord.GetDisplayName checks FULL name first, unconditionally, before even the
// persistent-cell placeholder — so this DTO deliberately doesn't fold the two facts into one
// "label" field; the tree provider's precedence logic needs both independently. Trailing optional
// param (not inserted next to EditorId) so every existing positional CellSummary(...) construction
// keeps compiling unchanged, the same accommodation IsPersistentWorldspaceCell's own default got.
public record CellSummary(
    string FormKey, string? EditorId, int? CellX, int? CellY,
    bool IsPersistentWorldspaceCell = false, string? FullName = null);

public record PlacedSummary(string FormKey, string? EditorId, string? BaseFormKey, string RecordType);

public record CellReferences(
    IReadOnlyList<PlacedSummary> Persistent,
    IReadOnlyList<PlacedSummary> Temporary);

public record WorldspaceSubBlockDto(int X, int Y, IReadOnlyList<CellSummary> Cells);

public record WorldspaceBlockDto(int X, int Y, IReadOnlyList<WorldspaceSubBlockDto> SubBlocks);

// #251: TopCells is a list, not a single nullable cell — a worldspace is only ever supposed to
// have one block-less cell row (its TopCell), but GetWorldspaceBlocks surfaces every one it finds
// rather than silently discarding anything past the first if the data is ever anomalous. Only the
// first carries IsPersistentWorldspaceCell = true.
public record WorldspaceBlocks(IReadOnlyList<WorldspaceBlockDto> Blocks, IReadOnlyList<CellSummary> TopCells);

// Flat row IRecordReads.GetWorldspaceCells returns for cells under a worldspace; the query service groups
// these into blocks/sub-blocks. BlockX/Y and SubX/Y are null for a worldspace's TopCell.
// #497: FullName trails for the same reason CellSummary's does — every existing positional
// construction keeps compiling.
public record CellLocationSummary(
    string FormKey, string? EditorId,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? CellX, int? CellY,
    string? FullName = null);
