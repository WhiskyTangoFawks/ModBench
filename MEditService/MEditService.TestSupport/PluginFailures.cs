using MEditService.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>Failures the real adapter answers, for a double to answer in its place.</summary>
public static class PluginFailures
{
    /// <summary>What a read of bytes Mutagen cannot parse answers.</summary>
    public static PluginFailure Unparsed()
    {
        using var folder = new ScratchDirectory("medit-unparsed-");
        var path = Path.Combine(folder.Path, "Unparsed.esp");
        File.WriteAllText(path, "not a plugin");
        return ReadOf(path);
    }

    /// <summary>What a read of a file that is not there answers.</summary>
    public static PluginFailure Inaccessible()
    {
        using var folder = new ScratchDirectory("medit-inaccessible-");
        return ReadOf(Path.Combine(folder.Path, "Absent.esp"));
    }

    private static PluginFailure ReadOf(string path) =>
        TestAdapters.Mutagen().ReadContent(new ModPath(ModKey.FromFileName(Path.GetFileName(path)), path), GameRelease.Fallout4).Failure();
}
