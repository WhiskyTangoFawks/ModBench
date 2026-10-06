namespace MEditService.Commands.Edits;

/// <summary>An exterior cell's grid position. A coordinate the request leaves out is null.</summary>
public readonly record struct GridPosition(int? X, int? Y);
