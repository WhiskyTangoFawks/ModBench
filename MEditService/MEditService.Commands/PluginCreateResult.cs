namespace MEditService.Commands;

/// <summary>Whether the create gesture wrote its plugin, or why it wrote nothing.</summary>
public sealed record PluginCreateResult(PluginCreateRefusal? Refusal = null, string? Message = null)
{
    public bool Applied => Refusal is null;
}

/// <summary>Why a create wrote nothing, each leaving the folder as it was (create-plugin, Refusals).</summary>
public enum PluginCreateRefusal
{
    FolderGone,
    FileExists,
    LightPluginUnsupported,

    /// <summary>The file system refused the write (ADR-0003), and the way out is outside Modbench.</summary>
    WriteFailed,
}
