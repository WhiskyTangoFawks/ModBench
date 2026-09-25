namespace MEditService.Commands;

/// <summary>What the create gesture wrote, at <see cref="Path"/>, or why it wrote nothing.</summary>
public sealed record PluginCreateResult(string Path, PluginCreateRefusal? Refusal = null, string? Message = null)
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
