using System.Text.Json.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Why decompile refused a plugin (ADR-0019): each value is a different way
/// out.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum DecompileRefusal
{
    None,

    /// <summary>No loaded plugin is the file name and origin the gesture named.</summary>
    PluginNotLoaded,

    /// <summary>The plugin is in no mod with a repository, so it has no working tree to go into; the
    /// way out is Track.</summary>
    NotInTrackedMod,

    /// <summary>ADR-0006's gate refused it, or the plugin cannot be read or deep-parsed
    /// at all.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>The plugin passed its gate, and git or the file system refused the write. Its source is
    /// as it was.</summary>
    WriteFailed,

    /// <summary>git is not on PATH (ADR-0007).</summary>
    GitUnavailable,
}

/// <summary>A plugin of the selection that wrote nothing, with the typed refusal and the message
/// naming the way out.</summary>
public sealed record DecompileRefused(PluginAddress Plugin, DecompileRefusal Refusal, string Message);

/// <summary>A cause no plugin of the selection escapes, found before any write.</summary>
public sealed record DecompileSelectionRefusal(DecompileRefusal Refusal, string Message);

/// <summary>Decompile over a selection (commands.md, A selection is one gesture): a cause no plugin
/// escapes is <see cref="SelectionRefusal"/>.</summary>
public sealed class DecompileSelectionResult
{
    private DecompileSelectionResult(
        IReadOnlyList<PluginAddress> landed, IReadOnlyList<DecompileRefused> refused, DecompileSelectionRefusal? selectionRefusal) =>
        (Landed, Refused, SelectionRefusal) = (landed, refused, selectionRefusal);

    public static DecompileSelectionResult PerPlugin(IReadOnlyList<PluginAddress> landed, IReadOnlyList<DecompileRefused> refused) =>
        new(landed, refused, selectionRefusal: null);

    public static DecompileSelectionResult WholeSelectionRefused(DecompileRefusal refusal, string message) =>
        new([], [], new DecompileSelectionRefusal(refusal, message));

    public IReadOnlyList<PluginAddress> Landed { get; }

    public IReadOnlyList<DecompileRefused> Refused { get; }

    public DecompileSelectionRefusal? SelectionRefusal { get; }

    public bool AllApplied => Refused.Count == 0 && SelectionRefusal is null;
}
