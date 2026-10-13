using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>The strings files Mod Management hands for the plugin copy at <c>pluginPath</c>: those in its folder's
/// strings folder named for it, and the archives at the folder's root named for it (ADR-0024).</summary>
public static class HandedStrings
{
    private static readonly string[] ArchiveExtensions = [".bsa", ".ba2"];
    private static readonly string[] StringsExtensions = [".strings", ".dlstrings", ".ilstrings"];

    public static PluginStrings Of(string pluginPath)
    {
        var folder = Path.GetDirectoryName(pluginPath) ?? throw new ArgumentException("No folder.", nameof(pluginPath));
        var stem = Path.GetFileNameWithoutExtension(pluginPath);
        var stringsFolder = Path.Combine(folder, "Strings");
        return new PluginStrings(
            Directory.Exists(folder) ? [.. Directory.EnumerateFiles(folder).Where(file => IsArchiveOf(stem, file)).Order(StringComparer.OrdinalIgnoreCase)] : [],
            Directory.Exists(stringsFolder) ? [.. Directory.EnumerateFiles(stringsFolder).Where(file => IsStringsFileOf(stem, file))] : []);
    }

    // Mutagen's CheckArchiveApplicability, as the companion rule holds it.
    private static bool IsArchiveOf(string stem, string file)
    {
        var name = Path.GetFileNameWithoutExtension(file);
        var cut = name.LastIndexOf(" - ", StringComparison.Ordinal);
        return ArchiveExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase)
            && (name.Equals(stem, StringComparison.OrdinalIgnoreCase) || (cut >= 0 && name[..cut].Equals(stem, StringComparison.OrdinalIgnoreCase)));
    }

    private static bool IsStringsFileOf(string stem, string file) =>
        StringsExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase)
        && Path.GetFileName(file).StartsWith($"{stem}_", StringComparison.OrdinalIgnoreCase);
}
