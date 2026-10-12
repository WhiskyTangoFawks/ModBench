using System.Buffers.Binary;
using System.IO.Hashing;

namespace MEditService.Commands.Engine;

/// <summary>The hash a manifest carries: xxHash64 with seed 0, written as Wabbajack writes it, the eight
/// little-endian bytes in base64.</summary>
internal readonly record struct FileHash(ulong Code)
{
    public static FileHash Of(Stream content)
    {
        var algorithm = new XxHash64();
        algorithm.Append(content);
        return new FileHash(algorithm.GetCurrentHashAsUInt64());
    }

    public override string ToString()
    {
        Span<byte> bytes = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(bytes, Code);
        return Convert.ToBase64String(bytes);
    }
}
