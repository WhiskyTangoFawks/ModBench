using System.Text.Json.Serialization;

namespace MEditService.Commands;

/// <summary>Why compile refused a plugin (ADR-0019): each value is a different way out.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CompileRefusal
{
    None,

    /// <summary>The load order holds no plugin of the file name and origin the gesture named.</summary>
    PluginNotInLoadOrder,

    /// <summary>The plugin is in no tracked mod, so it has no source; the way out is Track.</summary>
    PluginNotTracked,

    /// <summary>The mod's repository holds no source for the plugin; the way out is Decompile.</summary>
    NoSource,

    /// <summary>A source document could not be opened, as another program holds it; the way out is
    /// closing that program.</summary>
    SourceUnreadable,

    /// <summary>The source does not parse; the way out is Decompile.</summary>
    SourceDoesNotParse,

    /// <summary>The source does not round-trip through the codec (ADR-0006); the way out is
    /// Decompile.</summary>
    SourceDoesNotRoundTrip,

    /// <summary>Two source files claim one FormKey; which to keep is the user's call.</summary>
    FormKeyCollision,

    /// <summary>A light plugin holds a native FormID its slot cannot address.</summary>
    LightFormIdOutOfRange,

    /// <summary>A FormID the masters cannot map, so no binary is written (ADR-0008).</summary>
    FormIdUnmappable,

    /// <summary>The file system refused the write (ADR-0003); the source is untouched, so compiling again
    /// rebuilds it.</summary>
    WriteFailed,

    /// <summary>git is not on PATH (ADR-0007), a cause no plugin of a selection escapes.</summary>
    GitUnavailable,
}
