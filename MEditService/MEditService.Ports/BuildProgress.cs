namespace MEditService.Ports;

/// <summary>What a build can say about itself in flight, per mod: the mod in flight and how many of the
/// selection are done. The mod is null when the build is at rest.</summary>
public sealed record BuildProgress(string? Mod, int ModsDone, int ModsTotal);
