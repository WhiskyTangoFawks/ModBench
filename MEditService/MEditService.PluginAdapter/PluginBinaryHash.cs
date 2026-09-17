using System.Security.Cryptography;

namespace MEditService.PluginAdapter;

/// <summary>The content hash of a plugin binary (ADR-0009: validity by content, never by clock).
/// Sits in the one namespace both the index and the runtime watches may reference, so their two
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

    /// <summary>The same hash over bytes a caller already holds, spelled as <see cref="OfFile"/>
    /// spells it, so a file read once for two purposes hashes as one read would.</summary>
    public static string OfBytes(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    /// <summary>The same hash upper-cased, which is how the commit trailers spell it (ADR-0003).
    /// Throws rather than answering null: a caller here has just written the file.</summary>
    public static string TrailerFormOfFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    /// <summary>Every byte of the file for a caller comparing two plugins byte for byte, which needs
    /// the bytes or an exception rather than the no-evidence null below.</summary>
    public static Task<byte[]> ExactBytesOfFileAsync(string path, CancellationToken cancel = default) =>
        File.ReadAllBytesAsync(path, cancel);

    /// <summary>Every byte of the file, for a caller that hashes several plugins as one classification
    /// pass rather than one at a time. Null on the same no-evidence terms as <see cref="OfFile"/>.
    /// </summary>
    public static byte[]? BytesOfFile(string path)
    {
        try
        {
            return File.ReadAllBytes(path);
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }
}
