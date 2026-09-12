namespace MEditService.Core.Records;

public record CellReferences(
    IReadOnlyList<PlacedSummary> Persistent,
    IReadOnlyList<PlacedSummary> Temporary);
