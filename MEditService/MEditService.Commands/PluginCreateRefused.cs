namespace MEditService.Commands;

/// <summary>Why the create gesture wrote no plugin, and the message naming the way out.</summary>
public sealed record PluginCreateRefused(PluginCreateRefusal Refusal, string Message);

/// <summary>Why a create wrote nothing, each leaving the folder as it was (create-plugin, Refusals).</summary>
public enum PluginCreateRefusal
{
    FolderGone,
    FileExists,
    LightPluginUnsupported,
    NotAPluginFile,
    OriginNotAMod,

    /// <summary>The file system refused the write (ADR-0003), and the way out is outside Modbench.</summary>
    WriteFailed,

    /// <summary>No load order has been received, so the gesture has nothing to act on.</summary>
    NoLoadOrder,
}
