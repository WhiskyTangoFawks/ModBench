using System.Security.Cryptography;
using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter;

/// <summary>The content hash of a plugin binary (ADR-0003).
/// Sits in the one namespace both the index and the runtime watches may reference, so their two
/// hashes cannot drift apart.</summary>
public static class PluginBinaryHash
{
    /// <summary>Streams the file: the game's own master runs to hundreds of megabytes. Null when the
    /// file cannot be read — no evidence either way, so each caller decides; deliberately not an
    /// exception and not "unchanged".</summary>
    internal static string? OfFile(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            return Convert.ToHexStringLower(SHA256.HashData(stream));
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    /// <summary>The same hash over bytes a caller already holds, spelled as <see cref="OfFile"/>
    /// spells it, so a file read once for two purposes hashes as one read would.</summary>
    internal static string OfBytes(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    /// <summary>The same hash upper-cased, which is how the commit messages spell it (ADR-0007;
    /// ADR-0003).
    /// Throws rather than answering null: a caller here has just written the file.</summary>
    public static string TrailerFormOfFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    /// <summary>The hash and diagnoses from one read of the file. Null on <see cref="OfFile"/>'s
    /// no-evidence terms; null Diagnoses when the scan threw.</summary>
    public static FileClaim? ClaimOfFile(string path)
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }

        try
        {
            return new FileClaim(OfBytes(bytes), MalformedPluginScan.Scan(bytes));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return new FileClaim(OfBytes(bytes), null, ex);
        }
    }
}

public sealed record FileClaim(string Hash, IReadOnlyList<PluginDiagnosis>? Diagnoses, Exception? ScanError = null);
