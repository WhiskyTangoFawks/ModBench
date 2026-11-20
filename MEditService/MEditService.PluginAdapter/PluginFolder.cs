using MEditService.RepositoriesLib;

namespace MEditService.PluginAdapter;

/// <summary>The files of a folder that holds plugins, as the game names a plugin: without case.</summary>
internal static class PluginFolder
{
    // Its own purpose keeps it apart from the plugin source a build sets aside, where a mod's folder is its source folder too.
    internal static readonly KeptAside Replaced = new("replaced");

    /// <summary>The name of the file in <paramref name="path"/>'s folder spelled as its name, else spelled so without case; null when
    /// there is none.</summary>
    internal static string? HeldAt(string path)
    {
        var folder = Path.GetDirectoryName(path) ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory.");
        if (!Directory.Exists(folder)) return null;
        var name = Path.GetFileName(path);
        var held = Directory.EnumerateFiles(folder).Select(Path.GetFileName).Where(held => string.Equals(held, name, StringComparison.OrdinalIgnoreCase)).ToList();
        return held.Contains(name) ? name : held.FirstOrDefault();
    }
}
