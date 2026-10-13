using System.Buffers.Binary;
using System.Text;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A DDS file and the pixel data after its header.</summary>
internal sealed record Dds(byte[] File, byte[] Pixels)
{
    private const int HeaderEnd = 128;
    private const uint FourCcFlag = 4;

    public static Dds Dxt1(int width, int height, int mips) => Of(width, height, mips, "DXT1", dxgi: null, blockBytes: 8);

    public static Dds Bc7(int width, int height) => Of(width, height, 1, "DX10", dxgi: 98, blockBytes: 16);

    private static Dds Of(int width, int height, int mips, string fourCc, uint? dxgi, int blockBytes)
    {
        var pixels = Enumerable.Range(0, mips)
            .SelectMany(mip => Enumerable.Range(0, Math.Max(1, (width >> mip) / 4) * Math.Max(1, (height >> mip) / 4) * blockBytes))
            .Select((_, i) => (byte)(i % 251 + 1))
            .ToArray();
        var file = new byte[HeaderEnd + (dxgi is null ? 0 : 20) + pixels.Length];
        Encoding.ASCII.GetBytes("DDS ").CopyTo(file, 0);
        Put(file, 4, 124);
        Put(file, 8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000);
        Put(file, 12, (uint)height);
        Put(file, 16, (uint)width);
        Put(file, 20, (uint)(width / 4 * blockBytes));
        Put(file, 28, (uint)mips);
        Put(file, 76, 32);
        Put(file, 80, FourCcFlag);
        Encoding.ASCII.GetBytes(fourCc).CopyTo(file, 84);
        Put(file, 108, 0x1000 | 0x400000);
        if (dxgi is { } format)
        {
            Put(file, HeaderEnd, format);
            Put(file, HeaderEnd + 4, 3);
            Put(file, HeaderEnd + 12, 1);
        }

        pixels.CopyTo(file, file.Length - pixels.Length);
        return new Dds(file, pixels);
    }

    private static void Put(byte[] bytes, int at, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(at), value);
}
