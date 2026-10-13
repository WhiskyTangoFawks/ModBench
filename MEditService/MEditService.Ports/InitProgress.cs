using System.Text.Json.Serialization;

namespace MEditService.Ports;

/// <summary>The phases an init moves through, in order. <c>Serializing</c> advances one plugin at a
/// time: the whole-mod door serializes each plugin as one call with no per-record progress
/// callback.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum InitPhase
{
    Idle,
    Parsing,
    Serializing,

    /// <summary>Reading the mod's files to tell its assets from what its installation files yield.</summary>
    ReadingFiles,
    Committing,
}

/// <summary>What init can say about itself in flight. One shared instance, naming the mod in flight:
/// init is a single user gesture and nothing runs two at once. Counts plugins, not
/// records.</summary>
public sealed record InitProgress(string? Mod, InitPhase Phase, int PluginsDone, int PluginsTotal);
