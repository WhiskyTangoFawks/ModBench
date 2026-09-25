using System.Text.Json.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Why Track refused, typed rather than a string to match on (ADR-0019): each value is a
/// different way out, and the endpoint's status is one switch over them.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TrackRefusal
{
    None,

    /// <summary>No loaded plugin is the file name and origin the gesture named.</summary>
    PluginNotLoaded,

    /// <summary>The mod's repository already holds the plugin's source.</summary>
    AlreadyTracked,

    /// <summary>The origin is the game's own Data directory; the way out is a patch plugin (ADR-0007).</summary>
    DataDirectoryOrigin,

    /// <summary>ADR-0006 decision 2's gate: the plugin does not survive its own source, or cannot be
    /// read or deep-parsed at all. A data problem in the plugin, not a state conflict.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>An external change to the mod is unanswered (ADR-0003 invariant 3).</summary>
    ExternalChangeUnanswered,

    /// <summary>The plugin passed its gate, and git or the file system refused its baseline commit.</summary>
    CommitFailed,

    /// <summary>git is not on PATH, so no repository can be created at all (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>An earlier commit of the same answer failed and stopped the run before this plugin;
    /// answering again finishes it.</summary>
    StoppedByEarlierFailure,
}

/// <summary>One plugin's Track outcome, or a whole selection's refusal: applied-or-refusal, never an
/// exception (ADR-0014 invariant 4). The message names the way out.</summary>
public sealed record TrackResult(bool Applied, TrackRefusal Refusal, string Message)
{
    public static TrackResult Success() => new(true, TrackRefusal.None, "");

    public static TrackResult Refused(TrackRefusal refusal, string message) => new(false, refusal, message);
}

/// <summary>A plugin of the selection that wrote nothing of its own, with the typed refusal and the
/// message naming the way out.</summary>
public sealed record TrackRefused(PluginAddress Plugin, TrackRefusal Refusal, string Message);

/// <summary>Track over a selection answers per plugin (ADR-0019 invariant 4), except for a cause no
/// plugin escapes: <see cref="SelectionRefusal"/> names it, and nothing was written.</summary>
public sealed class TrackSelectionResult
{
    private TrackSelectionResult(
        IReadOnlyList<PluginAddress> landed, IReadOnlyList<TrackRefused> refused, TrackResult? selectionRefusal) =>
        (Landed, Refused, SelectionRefusal) = (landed, refused, selectionRefusal);

    public static TrackSelectionResult PerPlugin(IReadOnlyList<PluginAddress> landed, IReadOnlyList<TrackRefused> refused) =>
        new(landed, refused, selectionRefusal: null);

    public static TrackSelectionResult WholeSelectionRefused(TrackRefusal refusal, string message) =>
        new([], [], TrackResult.Refused(refusal, message));

    public IReadOnlyList<PluginAddress> Landed { get; }

    public IReadOnlyList<TrackRefused> Refused { get; }

    public TrackResult? SelectionRefusal { get; }

    public bool AllApplied => Refused.Count == 0 && SelectionRefusal is null;
}
