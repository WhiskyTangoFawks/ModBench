using System.Text.Json.Serialization;

namespace MEditService.Commands;

/// <summary>Why compile refused a plugin (ADR-0019): each value is a different way out.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CompileRefusal
{
    None,

    /// <summary>The load order holds no plugin of the file name and origin the gesture named.</summary>
    PluginNotInLoadOrder,

    /// <summary>The plugin is in no source mod, so it has no source; the way out is init.</summary>
    PluginNotCompiledPlugin,

    /// <summary>The way out is Decompile.</summary>
    PluginSourceUnreadable,

    /// <summary>Another plugin source of the mod has the same name but for case, which one mod folder cannot hold on
    /// Windows; the way out is renaming or removing one.</summary>
    TwinPluginSources,

    /// <summary>The plugin's source folder holds no files; the way out is Decompile.</summary>
    NoSource,

    /// <summary>A source document could not be opened, as another program holds it; the way out is
    /// closing that program.</summary>
    SourceFileHeld,

    /// <summary>A source file the Codec refuses, or source that differs from what it produces (ADR-0006): the way
    /// out is the files named, or Decompile for a file the codec produces nothing from.</summary>
    SourceDoesNotParse,

    /// <summary>The plugin written from the source would not hold a value the source does, such as a
    /// list element Mutagen writes no bytes for; the way out is editing that value.</summary>
    SourceValueDropped,

    /// <summary>Two source files claim one FormKey; which to keep is the user's call.</summary>
    FormKeyCollision,

    /// <summary>A plugin whose header flag, light or medium, limits its FormIDs holds a native FormID outside
    /// that range.</summary>
    FormIdOutsideFlagLimit,

    /// <summary>A FormID the masters cannot map, so no binary is written (ADR-0008).</summary>
    FormIdUnmappable,

    /// <summary>The source references a plugin the load order does not hold, so its masters have no
    /// order to be written in; the way out is that plugin in the load order.</summary>
    MasterNotInLoadOrder,

    /// <summary>A master the source references has a header that does not read, so the write cannot
    /// address its FormIDs; the way out is fixing or restoring that master.</summary>
    MasterUnreadable,

    /// <summary>The file system refused the write (ADR-0003); the source is untouched, so compiling again
    /// rebuilds it.</summary>
    WriteFailed,

    /// <summary>git is not on PATH (ADR-0007), a cause no plugin of a selection escapes.</summary>
    GitUnavailable,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,
}
