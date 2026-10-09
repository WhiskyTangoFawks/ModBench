namespace MEditService.PluginAdapter;

/// <summary>A folder holding one recompiled plugin and nothing else, outside every mod folder so a
/// half-written plugin is never mistaken for a tracked one; removed on dispose.</summary>
public sealed class ScratchPlugin : IDisposable
{
    private readonly string _folder;

    private ScratchPlugin(string folder, string pluginPath) => (_folder, PluginPath) = (folder, pluginPath);

    public static ScratchPlugin For(string pluginFileName)
    {
        var folder = Directory.CreateTempSubdirectory("medit-trackverify-").FullName;
        return new ScratchPlugin(folder, Path.Combine(folder, pluginFileName));
    }

    /// <summary>Where to write the plugin. Nothing is there until the caller has written it.</summary>
    public string PluginPath { get; }

    public void Dispose() => Directory.Delete(_folder, recursive: true);
}
