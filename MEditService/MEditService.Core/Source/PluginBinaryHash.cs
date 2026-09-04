using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary>The content hash of a plugin binary (ADR-0001: validity by content, never by clock).
/// Sits in the one namespace both the index and the runtime mirror may reference, so their two
/// hashes cannot drift apart.</summary>
public static class PluginBinaryHash
{
    /// <summary>Streams the file: the game's own master runs to hundreds of megabytes. Null when the
    /// file cannot be read — no evidence either way, so each caller decides; deliberately not an
    /// exception and not "unchanged".</summary>
    public static string? OfFile(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            return Convert.ToHexStringLower(SHA256.HashData(stream));
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }
}
