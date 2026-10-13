using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>What Mod Management hands, each stamped, beside the plugin copy at <c>pluginPath</c>: the strings files and
/// archives named for it, in its folder's strings folder and at its root (ADR-0013).</summary>
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
            Directory.Exists(folder) ? [.. Directory.EnumerateFiles(folder).Where(file => IsArchiveOf(stem, file)).Order(StringComparer.OrdinalIgnoreCase).Select(Stamped)] : [],
            Directory.Exists(stringsFolder) ? [.. Directory.EnumerateFiles(stringsFolder).Where(file => IsStringsFileOf(stem, file)).Select(Stamped)] : []);
    }

    public static StampedFile Stamped(string path)
    {
        var file = new FileInfo(path);
        return new StampedFile(path, $"{file.Length}/{file.LastWriteTimeUtc.Ticks}");
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
