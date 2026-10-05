using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Why Track refused (ADR-0019): each value is a different way out, and the
/// endpoint's status is one switch over them.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TrackRefusal
{
    None,

    /// <summary>The load order holds no plugin the mod provides.</summary>
    ModProvidesNoPlugin,

    /// <summary>The mod's repository already holds the plugin's source.</summary>
    AlreadyTracked,

    /// <summary>ADR-0006's gate refused it, or the plugin cannot be read or deep-parsed
    /// at all. A data problem in the plugin, not a state conflict.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>The plugin passed its gate, and the file system refused its source files, or git refused the track's one commit.</summary>
    CommitFailed,

    /// <summary>Every plugin of the mod was refused, each for its own reason, which the message names.</summary>
    NoPluginTracked,

    /// <summary>git is not on PATH, so no repository can be created at all (ADR-0007).</summary>
    GitUnavailable,
}

/// <summary>A mod of the selection that tracked: the plugins whose source landed in its commit, and the
/// plugins of it that wrote nothing, each with its reason. A mod none of whose plugins tracked is
/// refused instead.</summary>
public sealed record TrackedMod(IReadOnlyList<PluginAddress> Tracked, IReadOnlyList<ItemRefused<PluginAddress, TrackRefusal>> Refused);
