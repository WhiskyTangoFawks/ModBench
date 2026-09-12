namespace MEditService.Index;

public record CellReferences(
    IReadOnlyList<PlacedSummary> Persistent,
    IReadOnlyList<PlacedSummary> Temporary);
