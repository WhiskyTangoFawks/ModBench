namespace MEditService.SourceAdapter;

/// <summary>A folder holding one recompiled plugin and nothing else, removed on dispose. Where those
/// bytes land is the repository's answer (ADR-0014); what they mean is the caller's.</summary>
public sealed class ScratchPlugin : IDisposable
{
    private readonly string _folder;

    private ScratchPlugin(string folder, string pluginPath) => (_folder, PluginPath) = (folder, pluginPath);

    internal static ScratchPlugin For(string pluginFileName)
    {
        var folder = Directory.CreateTempSubdirectory("medit-trackverify-").FullName;
        return new ScratchPlugin(folder, Path.Combine(folder, pluginFileName));
    }

    /// <summary>Where to write the plugin. Nothing is there until the caller has written it.</summary>
    public string PluginPath { get; }

    public void Dispose() => Directory.Delete(_folder, recursive: true);
}
