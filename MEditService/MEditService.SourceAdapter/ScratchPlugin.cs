namespace MEditService.SourceAdapter;

/// <summary>A folder holding one recompiled plugin and nothing else, removed on dispose. Where those
/// bytes land is the repository's answer (ADR-0007); what they mean is the caller's.</summary>
public sealed class ScratchPlugin : IDisposable
{
    private readonly string _folder;

    internal ScratchPlugin(string folder, string pluginPath) => (_folder, PluginPath) = (folder, pluginPath);

    /// <summary>Where to write the plugin. Nothing is there until the caller has written it.</summary>
    public string PluginPath { get; }

    public void Dispose() => Directory.Delete(_folder, recursive: true);
}

public sealed partial class SourceRepository
{
    /// <summary>A scratch folder for <paramref name="pluginFileName"/>, outside every mod folder so
    /// a half-written plugin is never mistaken for a tracked one.</summary>
    public static ScratchPlugin ScratchFor(string pluginFileName)
    {
        var folder = Directory.CreateTempSubdirectory("medit-trackverify-").FullName;
        return new ScratchPlugin(folder, Path.Combine(folder, pluginFileName));
    }
}
