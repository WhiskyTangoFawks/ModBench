namespace MEditService.Index;

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);
