using System.Text.Json.Serialization;

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
