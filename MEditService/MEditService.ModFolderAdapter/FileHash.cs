using System.Buffers.Binary;
using System.IO.Hashing;

namespace MEditService.ModFolderAdapter;

/// <summary>The hash a manifest carries: xxHash64 with seed 0, written as Wabbajack writes it, the eight
/// little-endian bytes in base64.</summary>
public static class FileHash
{
    internal static string Of(Stream content)
    {
        var algorithm = new XxHash64();
        algorithm.Append(content);
        Span<byte> bytes = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(bytes, algorithm.GetCurrentHashAsUInt64());
        return Convert.ToBase64String(bytes);
    }

    /// <summary>The pin of a game folder mod (ADR-0022): a hash of the files it takes, each by path and hash, alphabetically.</summary>
    public static string OfFilesTaken(IEnumerable<HashedFile> files)
    {
        var text = string.Concat(files
            .OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ThenBy(file => file.Path, StringComparer.Ordinal)
            .Select(file => $"{file.Path}\n{file.Hash}\n"));
        using var content = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(text));
        return Of(content);
    }

    public static bool IsHash(string text)
    {
        Span<byte> bytes = stackalloc byte[sizeof(ulong)];
        return Convert.TryFromBase64String(text, bytes, out var written) && written == sizeof(ulong);
    }
}
