namespace MEditService.Core.Records;

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);
