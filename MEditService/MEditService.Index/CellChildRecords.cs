namespace MEditService.Index;

public record CellChildRecords(
    IReadOnlyList<ChildRecordSummary> Persistent,
    IReadOnlyList<ChildRecordSummary> Temporary);
