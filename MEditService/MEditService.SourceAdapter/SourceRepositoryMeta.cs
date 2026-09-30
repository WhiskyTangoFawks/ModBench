namespace MEditService.SourceAdapter;

/// <summary>The mod folder's own meta file, <c>meta.ini</c>, read as a source and never tracked
/// content (ADR-0003): the layout names it and nothing outside the repository reads it.</summary>
public sealed partial class SourceRepository
{
    /// <summary>The <c>version=</c> value Track's baseline trailers record, or null when absent —
    /// authored and manually-installed mods routinely have neither file nor line.</summary>
    public static string? UpstreamVersionIn(string modFolder)
    {
        var metaPath = Path.Combine(modFolder, "meta.ini");
        if (!File.Exists(metaPath)) return null;

        foreach (var line in File.ReadAllLines(metaPath))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("version=", StringComparison.OrdinalIgnoreCase))
                return trimmed["version=".Length..];
        }

        return null;
    }
}
