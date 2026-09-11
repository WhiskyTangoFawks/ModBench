namespace MEditService.Core.Commands;

/// <summary>Why Track refused, typed rather than a string to match on (ADR-0019): each value is a
/// different way out, and the endpoint's status is one switch over them.</summary>
public enum TrackRefusal
{
    None,

    /// <summary>Nothing in the load order carries the origin the gesture named.</summary>
    NoPluginWithOrigin,

    /// <summary>The mod folder already holds a repository, whose history a re-Track would discard.</summary>
    AlreadyTracked,

    /// <summary>The origin is the game's own Data directory; the way out is a patch plugin (ADR-0007).</summary>
    DataDirectoryOrigin,

    /// <summary>ADR-0006 decision 2's gate: the plugin does not survive its own source, or cannot be
    /// deep-parsed at all. A data problem in the plugin, not a state conflict.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>git is not on PATH, so no repository can be created at all (ADR-0007).</summary>
    GitUnavailable,
}

/// <summary>Track's outcome — applied-or-refusal, never an exception (ADR-0014 invariant 4). The
/// message names the way out, since a refusal the user cannot act on is dead UI.</summary>
public sealed record TrackResult(bool Applied, TrackRefusal Refusal, string Message)
{
    public static TrackResult Success() => new(true, TrackRefusal.None, "");

    public static TrackResult Refused(TrackRefusal refusal, string message) => new(false, refusal, message);
}
