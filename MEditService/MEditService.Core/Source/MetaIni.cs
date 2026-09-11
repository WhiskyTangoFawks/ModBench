using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary><c>meta.ini</c> read as a source, never tracked content (ADR-0003). The one
/// reading shared by Track's baseline trailers and the external-change classifier.</summary>
internal static class MetaIni
{
    /// <summary>The <c>version=</c> value, or null when absent — authored/manually-installed mods
    /// routinely have neither file nor line.</summary>
    internal static string? ReadVersion(string modFolder)
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

    /// <summary>SHA-256 of <c>meta.ini</c>'s raw bytes, or null when absent — opaque, never interpreted.</summary>
    internal static string? ComputeSha256(string modFolder)
    {
        var metaPath = Path.Combine(modFolder, "meta.ini");
        return File.Exists(metaPath) ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(metaPath))) : null;
    }
}
