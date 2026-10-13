using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>The strings files Mod Management would hand for a fixture's plugin copy in <c>folder</c>: every file in
/// its strings folder, and every archive at its root (ADR-0024).</summary>
public static class HandedStrings
{
    private static readonly string[] ArchiveExtensions = [".bsa", ".ba2"];

    public static PluginStrings Beside(string folder)
    {
        var stringsFolder = Path.Combine(folder, "Strings");
        return new PluginStrings(
            Directory.Exists(folder)
                ? [.. Directory.EnumerateFiles(folder)
                    .Where(file => ArchiveExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase))
                    .Order(StringComparer.OrdinalIgnoreCase)]
                : [],
            Directory.Exists(stringsFolder) ? [.. Directory.EnumerateFiles(stringsFolder)] : []);
    }
}
