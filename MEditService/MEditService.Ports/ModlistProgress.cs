namespace MEditService.Ports;

/// <summary>A modlist gesture's progress over a selection: the mod in flight, null at rest, and how many mods are
/// done.</summary>
public sealed record ModlistProgress(string? Mod, int ModsDone, int ModsTotal);

public sealed record UpdateManifestProgressNotification(ModlistProgress Progress) : INotification;

public sealed record RestoreFromManifestProgressNotification(ModlistProgress Progress) : INotification;
