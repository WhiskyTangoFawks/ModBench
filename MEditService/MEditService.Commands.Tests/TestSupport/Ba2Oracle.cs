using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using K4os.Compression.LZ4;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Reads a BA2 of any version, given each reference reader's header length: Wabbajack's and CreationsForge's.</summary>
internal static class Ba2Oracle
{
    private const uint Sentinel = 0xBAADF00D;

    public static int WabbajackHeaderLength(uint version, string _) => version switch { 2 => 32, 3 => 36, _ => 24 };

    public static int CreationsForgeHeaderLength(uint version, string type) =>
        type == "DX10" && version is 3 or 7 or 8 ? 36 : version is 2 or 3 ? 32 : 24;

    public static Dictionary<string, byte[]> Read(byte[] ba2, Func<uint, string, int> headerLength)
    {
        var version = U32(ba2, 4);
        var type = Encoding.ASCII.GetString(ba2, 8, 4);
        var count = (int)U32(ba2, 12);
        var nameTable = (int)BinaryPrimitives.ReadUInt64LittleEndian(ba2.AsSpan(16));
        var at = headerLength(version, type);
        var data = new List<byte[]>();
        for (var i = 0; i < count; i++)
        {
            data.Add(type == "GNRL" ? ReadGeneral(ba2, ref at) : ReadTexture(ba2, ref at, version));
        }

        var names = new List<string>();
        for (var i = 0; i < count; i++)
        {
            var length = BinaryPrimitives.ReadUInt16LittleEndian(ba2.AsSpan(nameTable));
            names.Add(Encoding.UTF8.GetString(ba2, nameTable + 2, length));
            nameTable += 2 + length;
        }

        return names.Zip(data).ToDictionary(pair => pair.First, pair => pair.Second);
    }

    private static byte[] ReadGeneral(byte[] ba2, ref int at)
    {
        var (offset, packed, whole) = ((int)BinaryPrimitives.ReadUInt64LittleEndian(ba2.AsSpan(at + 16)), (int)U32(ba2, at + 24), (int)U32(ba2, at + 28));
        Assert.Equal(Sentinel, U32(ba2, at + 32));
        at += 36;
        return packed == 0 ? ba2[offset..(offset + whole)] : Inflate(ba2.AsSpan(offset, packed), whole);
    }

    private static byte[] ReadTexture(byte[] ba2, ref int at, uint version)
    {
        var chunks = ba2[at + 13];
        Assert.Equal(24, BinaryPrimitives.ReadUInt16LittleEndian(ba2.AsSpan(at + 14)));
        at += 24;
        var pixels = new List<byte>();
        for (var i = 0; i < chunks; i++)
        {
            var (offset, packed, whole) = ((int)BinaryPrimitives.ReadUInt64LittleEndian(ba2.AsSpan(at)), (int)U32(ba2, at + 8), (int)U32(ba2, at + 12));
            Assert.Equal(Sentinel, U32(ba2, at + 20));
            at += 24;
            pixels.AddRange(
                packed == 0 ? ba2[offset..(offset + whole)]
                : version == 3 ? Unblock(ba2.AsSpan(offset, packed), whole)
                : Inflate(ba2.AsSpan(offset, packed), whole));
        }

        return [.. pixels];
    }

    private static byte[] Inflate(ReadOnlySpan<byte> packed, int whole)
    {
        using var zlib = new ZLibStream(new MemoryStream(packed.ToArray()), CompressionMode.Decompress);
        var bytes = new byte[whole];
        zlib.ReadExactly(bytes);
        return bytes;
    }

    private static byte[] Unblock(ReadOnlySpan<byte> packed, int whole)
    {
        var bytes = new byte[whole];
        Assert.Equal(whole, LZ4Codec.Decode(packed, bytes));
        return bytes;
    }

    private static uint U32(byte[] bytes, int at) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at));
}
