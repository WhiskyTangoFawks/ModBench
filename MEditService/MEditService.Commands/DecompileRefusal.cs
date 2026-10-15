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

    /// <summary>The plugin is in no source mod, so it has no working tree to go into; the
    /// way out is decompile and commit on its mod.</summary>
    NotInSourceMod,

    /// <summary>ADR-0006's gate refused it, or the plugin cannot be read or deep-parsed
    /// at all.</summary>
    RoundTripFailed,

    /// <summary>A localized plugin whose strings file is missing; the way out is restoring it.</summary>
    MissingLocalizationStrings,

    /// <summary>The plugin source holds twin folders and none is its tree; the way out is removing the extra by
    /// hand. Nothing was written.</summary>
    AmbiguousSource,

    /// <summary>The plugin passed its gate, and git or the file system refused the write. Its source is
    /// as it was.</summary>
    WriteFailed,

    /// <summary>git could not report whether the plugin source has working-tree changes, so nothing says a decompile
    /// would lose none. Nothing was written.</summary>
    WorkingTreeStatusUnreadable,

    /// <summary>git is not on PATH (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>The plugin source has working-tree changes a decompile would replace, and the request did not
    /// force; the way out is requesting it again with force.</summary>
    WorkingTreeChanges,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,
}
