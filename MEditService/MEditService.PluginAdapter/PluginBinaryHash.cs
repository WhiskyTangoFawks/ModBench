using System.Security.Cryptography;
using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter;

/// <summary>The content hash of a plugin binary (ADR-0003).</summary>
internal static class PluginBinaryHash
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
    /// Throws rather than answering null: its caller reads or has just written the file.</summary>
    internal static string TrailerFormOfFile(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    /// <summary>The hash and diagnoses from one read of the file.</summary>
    internal static PluginAnswer<FileClaim> ClaimOfFile(string path)
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new PluginFailure.Inaccessible(ex);
        }

        return PluginAnswer.Of(new FileClaim(OfBytes(bytes), PluginFailure.Answer<IReadOnlyList<PluginDiagnosis>>(() => MalformedPluginScan.Scan(bytes))));
    }
}

/// <summary>A plugin file's hash, and the malformed records the same read of it found.</summary>
public sealed record FileClaim(string Hash, PluginAnswer<IReadOnlyList<PluginDiagnosis>> Diagnoses);
