using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary>What the mod folder's <c>meta.ini</c> says, as the repository answers it: the upstream
/// version, and the file's own hash, opaque and never interpreted. Both null when there is no such
/// file (ADR-0003).</summary>
public sealed record ModMetaFacts(string? UpstreamVersion, string? MetaSha256);

/// <summary>The mod folder's own meta file, which the layout names and nothing outside the
/// repository reads.</summary>
public sealed partial class SourceRepository
{
    /// <summary>What Track's baseline trailers record and the external-change classifier compares
    /// against them, from one pass over the folder.</summary>
    public static ModMetaFacts MetaFactsIn(string modFolder) =>
        new(MetaIni.ReadVersion(modFolder), MetaIni.ComputeSha256(modFolder));
}

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
