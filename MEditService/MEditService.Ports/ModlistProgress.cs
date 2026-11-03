using System.Text.Json.Serialization;

namespace MEditService.Ports;

/// <summary>The step version in git is at within a mod. Plugins step one at a time: the whole-mod door serializes
/// each plugin as one call with no per-record progress callback.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum VersionInGitPhase
{
    Parsing,
    Serializing,
    Committing,
}

/// <summary>A modlist gesture's progress over a selection: the mod in flight (null at rest) and the mods done.</summary>
public sealed record ModlistProgress(string? Mod, int ModsDone, int ModsTotal);

public sealed record BuildProgressNotification(ModlistProgress Progress) : INotification;

public sealed record VersionInGitProgressNotification(ModlistProgress Progress, VersionInGitPhase? Phase) : INotification;
