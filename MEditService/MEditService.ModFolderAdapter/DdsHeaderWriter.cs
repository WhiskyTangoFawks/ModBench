using System.Buffers.Binary;
using System.Text;

namespace MEditService.ModFolderAdapter;

/// <summary>The header of a single 2D texture or a cubemap, laid out as DirectXTex writes it: the legacy header where DirectXTex has a pixel format
/// for the DXGI format, the DX10 extension where it has none.</summary>
internal static class DdsHeaderWriter
{
    private const int MainLength = DdsHeader.MainLength;
    private const int ExtensionLength = DdsHeader.ExtensionLength;
    private const uint FourCc = DdsHeader.FourCcFlag;
    private const uint Rgb = 0x40;
    private const uint Rgba = 0x41;
    private const uint Alpha = 0x2;
    private const uint Luminance = 0x20000;
    private const uint LuminanceAlpha = 0x20001;
    private const uint BumpDuDv = 0x80000;
    private const uint CapsFlag = 0x1;
    private const uint HeightFlag = 0x2;
    private const uint WidthFlag = 0x4;
    private const uint PitchFlag = 0x8;
    private const uint PixelFormatFlag = 0x1000;
    private const uint MipCountFlag = 0x20000;
    private const uint LinearSizeFlag = 0x80000;
    private const uint TextureCaps = 0x1000;
    private const uint ComplexCaps = 0x8;
    private const uint MipmapCaps = 0x400000;
    private const uint CubemapWithAllFaces = 0xFE00;
    private const uint TextureCubeMisc = 0x4;
    private const uint Texture2D = DdsHeader.Texture2D;

    private sealed record PixelFormat(uint Flags, uint Code = 0, uint Bits = 0, uint Red = 0, uint Green = 0, uint Blue = 0, uint AlphaMask = 0);

    // DirectXTex's GetPixelFormat. Its DXT2 and DXT4 need a premultiplied-alpha flag a BA2 does not carry, so BC2 and BC3 are DXT3 and DXT5.
    private static readonly Dictionary<byte, PixelFormat> Legacy = new()
    {
        [2] = new(FourCc, 116),
        [10] = new(FourCc, 113),
        [11] = new(FourCc, 36),
        [13] = new(FourCc, 110),
        [16] = new(FourCc, 115),
        [28] = new(Rgba, 0, 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000),
        [31] = new(BumpDuDv, 0, 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000),
        [34] = new(FourCc, 112),
        [35] = new(Rgb, 0, 32, 0xFFFF, 0xFFFF0000),
        [37] = new(BumpDuDv, 0, 32, 0xFFFF, 0xFFFF0000),
        [41] = new(FourCc, 114),
        [49] = new(LuminanceAlpha, 0, 16, 0xFF, 0, 0, 0xFF00),
        [51] = new(BumpDuDv, 0, 16, 0xFF, 0xFF00),
        [54] = new(FourCc, 111),
        [56] = new(Luminance, 0, 16, 0xFFFF),
        [61] = new(Luminance, 0, 8, 0xFF),
        [65] = new(Alpha, 0, 8, 0, 0, 0, 0xFF),
        [68] = new(FourCc, Cc("RGBG")),
        [69] = new(FourCc, Cc("GRGB")),
        [71] = new(FourCc, Cc("DXT1")),
        [74] = new(FourCc, Cc("DXT3")),
        [77] = new(FourCc, Cc("DXT5")),
        [80] = new(FourCc, Cc("BC4U")),
        [81] = new(FourCc, Cc("BC4S")),
        [83] = new(FourCc, Cc("BC5U")),
        [84] = new(FourCc, Cc("BC5S")),
        [85] = new(Rgb, 0, 16, 0xF800, 0x7E0, 0x1F),
        [86] = new(Rgba, 0, 16, 0x7C00, 0x3E0, 0x1F, 0x8000),
        [87] = new(Rgba, 0, 32, 0xFF0000, 0xFF00, 0xFF, 0xFF000000),
        [88] = new(Rgb, 0, 32, 0xFF0000, 0xFF00, 0xFF),
        [107] = new(FourCc, Cc("YUY2")),
        [115] = new(Rgba, 0, 16, 0xF00, 0xF0, 0xF, 0xF000),
    };

    public static byte[] Write(ushort width, ushort height, byte mips, byte dxgiFormat, bool isCubemap)
    {
        var (flag, pitchOrSize) = PitchOrLinearSize(width, height, dxgiFormat);
        var pixelFormat = Legacy.GetValueOrDefault(dxgiFormat);
        var header = new byte[pixelFormat is null ? MainLength + ExtensionLength : MainLength];
        Encoding.ASCII.GetBytes("DDS ").CopyTo(header, 0);
        Put(header, 4, 124);
        Put(header, 8, CapsFlag | HeightFlag | WidthFlag | PixelFormatFlag | MipCountFlag | flag);
        Put(header, 12, height);
        Put(header, 16, width);
        Put(header, 20, pitchOrSize);
        Put(header, 24, 1);
        Put(header, 28, mips);
        Put(header, 76, 32);
        if (pixelFormat is null)
        {
            Put(header, 80, FourCc);
            Put(header, 84, Cc("DX10"));
            Put(header, MainLength, dxgiFormat);
            Put(header, MainLength + 4, Texture2D);
            Put(header, MainLength + 8, isCubemap ? TextureCubeMisc : 0);
            Put(header, MainLength + 12, 1);
        }
        else
        {
            Put(header, 80, pixelFormat.Flags);
            Put(header, 84, pixelFormat.Code);
            Put(header, 88, pixelFormat.Bits);
            Put(header, 92, pixelFormat.Red);
            Put(header, 96, pixelFormat.Green);
            Put(header, 100, pixelFormat.Blue);
            Put(header, 104, pixelFormat.AlphaMask);
        }

        Put(header, 108, TextureCaps | (mips > 1 ? ComplexCaps | MipmapCaps : 0) | (isCubemap ? ComplexCaps : 0));
        Put(header, 112, isCubemap ? CubemapWithAllFaces : 0);
        return header;
    }

    private static (uint Flag, uint Value) PitchOrLinearSize(ushort width, ushort height, byte dxgi)
    {
        if (BlockBytes(dxgi) is { } block)
            return (LinearSizeFlag, (uint)(Math.Max(1, (width + 3) / 4) * Math.Max(1, (height + 3) / 4) * block));
        if (dxgi is 68 or 69 or 107) return (PitchFlag, (uint)((width + 1) / 2 * 4));
        return (PitchFlag, (uint)((width * BitsPerPixel(dxgi) + 7) / 8));
    }

    private static int? BlockBytes(byte dxgi) => dxgi switch
    {
        >= 70 and <= 72 or >= 79 and <= 81 => 8,
        >= 73 and <= 78 or >= 82 and <= 84 or >= 94 and <= 99 => 16,
        _ => null,
    };

    private static int BitsPerPixel(byte dxgi) => dxgi switch
    {
        >= 1 and <= 4 => 128,
        >= 5 and <= 8 => 96,
        >= 9 and <= 22 => 64,
        >= 23 and <= 47 or 67 or >= 87 and <= 93 => 32,
        >= 48 and <= 59 or 85 or 86 or 115 => 16,
        >= 60 and <= 65 => 8,
        66 => 1,
        _ => throw new InvalidDataException($"DXGI format {dxgi} has no DDS header Modbench writes."),
    };

    private static uint Cc(string fourCc) => BinaryPrimitives.ReadUInt32LittleEndian(Encoding.ASCII.GetBytes(fourCc));

    private static void Put(byte[] bytes, int at, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(at), value);
}
