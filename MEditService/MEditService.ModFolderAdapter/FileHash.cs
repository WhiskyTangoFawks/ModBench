using System.Buffers.Binary;
using System.IO.Hashing;

namespace MEditService.ModFolderAdapter;

/// <summary>The hash a manifest carries: xxHash64 with seed 0, written as Wabbajack writes it, the eight
/// little-endian bytes in base64.</summary>
internal static class FileHash
{
    public static string Of(Stream content)
    {
        var algorithm = new XxHash64();
        algorithm.Append(content);
        Span<byte> bytes = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(bytes, algorithm.GetCurrentHashAsUInt64());
        return Convert.ToBase64String(bytes);
    }
}
