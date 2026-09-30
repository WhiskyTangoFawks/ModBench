namespace MEditService.Commands;

/// <summary>Whether the create gesture wrote its plugin, or why it wrote nothing.</summary>
public sealed record PluginCreateResult(PluginCreateRefusal? Refusal = null, string? Message = null)
{
    public bool Applied => Refusal is null;
}

/// <summary>Why a create wrote nothing, each found before any write (create-plugin, Refusals).</summary>
public enum PluginCreateRefusal
{
    FolderGone,
    FileExists,
    LightPluginUnsupported,
}
