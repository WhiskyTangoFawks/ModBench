using System.Security.Cryptography;
using System.Text;

namespace MEditService.Core.Source;

/// <summary>
/// The git blob hash of a byte sequence: <c>SHA-1("blob " + length + "\0" + content)</c>, git's own
/// object-name format. Not a hash of our own choosing — <c>documents.content_hash</c> exists to be
/// <i>the same identifier git uses</i> (ADR-0041), so that the document body stored in the
/// index and the source file sitting in a tracked mod folder are provably the same object without
/// either side re-reading the other.
///
/// <para><b>What this buys, concretely.</b> Record-wide agreement becomes a SQL aggregate:
/// <c>COUNT(DISTINCT content_hash) = 1</c> per FormKey means every plugin in the load order says
/// byte-identical things about that record — the plugins-tree agreement badge, and the NoConflict /
/// ITM fast paths, without materializing or comparing a single field.</para>
///
/// <para><b>The semantics are one-directional, deliberately.</b> Hash equality
/// implies the bytes are identical. Hash <i>in</i>equality does <b>not</b> imply a user edit, and
/// must never be reported as one: a consumer that sees a mismatch falls back to a byte compare (or
/// re-reads the source text) before concluding anything. The reason is measured, not theoretical:
/// bytes serialized from a plugin's <i>binary overlay</i> and a source file written from a
/// <i>deep parse</i> of the same plugin are not always structurally
/// faithful to each other (which is why Mutagen stays pinned). Serializing all
/// 3,940 records of the committed cut-down plugin both ways found 4 divergences — three populated
/// exterior Cells inlining children (handled separately by the ingest-side container strip)
/// and one genuine reader-fidelity difference, Cell <c>092A18:Fallout4.esm</c>, whose overlay emits
/// <c>Lighting.Versioning: ["Break0","Break1",…]</c> where the deep parse emits
/// <c>["Break0"]</c> — 1,201 B against 1,169 B. That is roughly 1 record in 3,940, and a deep
/// <i>copy</i> does not close it (it copies the overlay's own divergent values); only deep-parsing
/// at ingest would, at a cost the ingest path will not pay. For a tracked plugin the hazard is
/// closed structurally — it ingests from its source text rather than its binary, so both sides of
/// the comparison come from the same parse.</para>
/// </summary>
internal static class GitBlobHash
{
    /// <summary>
    /// The 40-character lowercase hex object name git would give <paramref name="content"/> — the
    /// same string <c>git hash-object</c> prints, which is what
    /// <c>GitBlobHashTests</c> asserts against rather than against a second copy of this arithmetic.
    /// </summary>
    internal static string Of(ReadOnlySpan<byte> content)
    {
        // The length in the header is the *byte* count, and the header itself is ASCII — spelled out
        // because getting either wrong still produces a plausible-looking 40-hex string that agrees
        // with git for every ASCII-only body and silently disagrees for the first record carrying a
        // non-ASCII name. GitBlobHashTests covers exactly that case with real multi-byte text.
        Span<byte> header = stackalloc byte[32];
        var headerLength = Encoding.ASCII.GetBytes($"blob {content.Length}\0", header);

        // Incremental rather than concatenate-then-hash: a document body reaches 7.5 MB in real data
        // and this runs once per record over a multi-million-record load order, so the copy a single
        // combined buffer would cost is paid on every one of them for no benefit.
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
        hash.AppendData(header[..headerLength]);
        hash.AppendData(content);

        Span<byte> digest = stackalloc byte[20];
        hash.GetHashAndReset(digest);
        return Convert.ToHexStringLower(digest);
    }
}
