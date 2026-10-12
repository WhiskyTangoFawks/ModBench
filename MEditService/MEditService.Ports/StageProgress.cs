namespace MEditService.Ports;

/// <summary>Stage's progress over a selection: the mod in flight, null at rest, and how many mods are done.</summary>
public sealed record StageProgress(string? Mod, int ModsDone, int ModsTotal);

public sealed record StageProgressNotification(StageProgress Progress) : INotification;
