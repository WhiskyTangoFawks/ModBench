using System.Text.Json.Serialization;

namespace MEditService.Ports;

/// <summary>The phases a Track moves through, in order. <c>Serializing</c> advances one plugin at a
/// time: the whole-mod door serializes each plugin as one call with no per-record progress
/// callback.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TrackPhase
{
    Idle,
    Parsing,
    Serializing,
    Committing,
}

/// <summary>What Track can say about itself in flight. One shared instance, not
/// per-origin: Track is a single user gesture and nothing runs two at once. Counts plugins, not
/// records.</summary>
public sealed record TrackProgress(string? Origin, TrackPhase Phase, int PluginsDone, int PluginsTotal)
{
    public static readonly TrackProgress Idle = new(null, TrackPhase.Idle, 0, 0);
}
