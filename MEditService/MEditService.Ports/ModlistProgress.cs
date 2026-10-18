namespace MEditService.Ports;

/// <summary>A modlist gesture's progress over a selection: the id its client named it by, the mod in flight, null at
/// rest, and how many mods are done.</summary>
public sealed record ModlistProgress(string? Gesture, string? Mod, int ModsDone, int ModsTotal);

public sealed record UpdateManifestProgressNotification(ModlistProgress Progress) : INotification;

public sealed record RestoreFromManifestProgressNotification(ModlistProgress Progress) : INotification;

public sealed record BuildProgressNotification(ModlistProgress Progress) : INotification;
