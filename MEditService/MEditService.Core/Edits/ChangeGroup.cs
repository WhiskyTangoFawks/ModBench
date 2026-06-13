namespace MEditService.Core.Edits;

public record ChangeGroup(Guid Id, string Operation, string? Description, DateTime CreatedAt, int ChangeCount);
