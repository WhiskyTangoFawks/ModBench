using System.Security.Cryptography;
using System.Text;

namespace MEditService.Core.Source;

/// <summary>The content hash: how a stored body and a tracked source file are named the same object
/// (ADR-0007).</summary>
public sealed partial class SourceRepository
{
    /// <summary>The name git gives these same bytes, so equality proves the tracked file holds them.
    /// One-directional: inequality never proves an edit, because overlay and deep-parse serialization
    /// diverge on a few records (4 of 3,940 measured).</summary>
    public static string ContentHash(ReadOnlySpan<byte> body) => GitBlobHash.Of(body);
}

/// <summary>Git's own blob object name, so <c>documents.content_hash</c> and a tracked source file
/// are provably the same object (ADR-0007). One-directional: equality proves identical bytes;
/// inequality never proves an edit.</summary>
internal static class GitBlobHash
{
    // Inequality is not an edit because overlay and deep-parse serialization diverge on a few records
    // (4 of 3,940 measured, e.g. Cell 092A18:Fallout4.esm Lighting.Versioning).

    /// <summary>The 40-character lowercase hex name <c>git hash-object</c> prints.</summary>
    internal static string Of(ReadOnlySpan<byte> content)
    {
        // The header's length is the byte count and the header is ASCII: getting either wrong still yields
        // a plausible 40-hex string that agrees with git for ASCII-only bodies and silently disagrees for
        // the first non-ASCII name.
        Span<byte> header = stackalloc byte[32];
        var headerLength = Encoding.ASCII.GetBytes($"blob {content.Length}\0", header);

        // Incremental rather than concatenate-then-hash: a document body reaches 7.5 MB and this runs once
        // per record over a multi-million-record load order.
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
        hash.AppendData(header[..headerLength]);
        hash.AppendData(content);

        Span<byte> digest = stackalloc byte[20];
        hash.GetHashAndReset(digest);
        return Convert.ToHexStringLower(digest);
    }
}
