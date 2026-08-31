using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary>
/// <c>meta.ini</c> read as a source, never tracked content (ADR-0041 amendment: "never track a file
/// that changes for non-content reasons") — the one place both halves of the meta tell are read:
/// <see cref="TrackService"/> at Track time (writing the baseline trailers) and the external-change
/// classifier at detection time (comparing a freshly-read value against the last baseline's
/// trailer), so the two callers share one reading of the file rather than two copies drifting.
/// </summary>
internal static class MetaIni
{
    /// <summary>The <c>version=</c> line's value, or null when <c>meta.ini</c> is absent or carries
    /// no such line — authored/manually-installed mods routinely have neither.</summary>
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

    /// <summary>SHA-256 of <c>meta.ini</c>'s raw bytes, or null when the file is absent — opaque,
    /// never interpreted, same posture as <see cref="ReadVersion"/>.</summary>
    internal static string? ComputeSha256(string modFolder)
    {
        var metaPath = Path.Combine(modFolder, "meta.ini");
        return File.Exists(metaPath) ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(metaPath))) : null;
    }
}
