using System.Buffers.Binary;
using System.Text;

namespace MEditService.ModFolderAdapter;

internal sealed record DdsHeader(int Length, ushort Width, ushort Height, byte Mips, byte DxgiFormat, bool IsCubeMap)
{
    private const int MainLength = 128;
    private const int ExtensionLength = 20;
    private const uint FourCcFlag = 0x4;
    private const uint RgbFlag = 0x40;
    private const uint LuminanceFlag = 0x20000;
    private const uint CubeMapCaps = 0x200;
    private const uint VolumeCaps = 0x200000;
    private const uint CubeMapMisc = 0x4;
    private const uint Texture2D = 3;
    private const uint AlphaPixelsFlag = 0x1;
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

    private static readonly Dictionary<string, byte> FormatOfFourCc = new()
    {
        ["DXT1"] = 71,
        ["DXT3"] = 74,
        ["DXT5"] = 77,
        ["ATI1"] = 80,
        ["BC4U"] = 80,
        ["ATI2"] = 83,
        ["BC5U"] = 83,
    };

    private const byte Rgba8 = 28;
    private const byte Bgra8 = 87;
    private const byte R8 = 61;

    public static DdsHeader Read(Stream dds, string source)
    {
        var header = new byte[MainLength + ExtensionLength];
        var read = dds.ReadAtLeast(header.AsSpan(0, MainLength), MainLength, throwOnEndOfStream: false);
        if (read < MainLength || Encoding.ASCII.GetString(header, 0, 4) != "DDS " || U32(header, 4) != 124)
            throw Refusal(source, "it has no DDS header");

        var height = U32(header, 12);
        var width = U32(header, 16);
        var mips = Math.Max(1u, U32(header, 28));
        if (height is 0 or > ushort.MaxValue || width is 0 or > ushort.MaxValue || mips > byte.MaxValue)
            throw Refusal(source, "its size is out of range");
        if ((U32(header, 112) & VolumeCaps) != 0)
            throw Refusal(source, "a volume texture is not a 2D texture");

        var extended = (U32(header, 80) & FourCcFlag) != 0 && Encoding.ASCII.GetString(header, 84, 4) == "DX10";
        var isCube = (U32(header, 112) & CubeMapCaps) != 0;
        byte format;
        if (extended)
        {
            if (dds.ReadAtLeast(header.AsSpan(MainLength), ExtensionLength, throwOnEndOfStream: false) < ExtensionLength)
                throw Refusal(source, "its extended header is cut short");
            var dxgi = U32(header, MainLength);
            if (dxgi is 0 or > byte.MaxValue) throw Refusal(source, $"DXGI format {dxgi} has no place in an archive");
            if (U32(header, MainLength + 4) != Texture2D || U32(header, MainLength + 12) != 1)
                throw Refusal(source, "it is not a single 2D texture");
            format = (byte)dxgi;
            isCube |= (U32(header, MainLength + 8) & CubeMapMisc) != 0;
        }
        else
        {
            format = FormatOf(header, source);
        }

        return new DdsHeader(extended ? MainLength + ExtensionLength : MainLength, (ushort)width, (ushort)height, (byte)mips, format, isCube);
    }

    /// <summary>The header of a single 2D texture, laid out as DirectXTex writes it: the legacy header where it has a pixel format
    /// for the DXGI format, the DX10 extension where it has none.</summary>
    public static byte[] Write(ushort width, ushort height, byte mips, byte dxgiFormat)
    {
        var pixelFormat = LegacyPixelFormats.GetValueOrDefault(dxgiFormat);
        var header = new byte[pixelFormat is null ? MainLength + ExtensionLength : MainLength];
        var block = BlockBytes(dxgiFormat);
        var (flag, pitchOrSize) = block is { } bytes
            ? (LinearSizeFlag, (uint)(Math.Max(1, (width + 3) / 4) * Math.Max(1, (height + 3) / 4) * bytes))
            : (PitchFlag, (uint)((width * BitsPerPixel(dxgiFormat) + 7) / 8));
        Encoding.ASCII.GetBytes("DDS ").CopyTo(header, 0);
        Put(header, 4, 124);
        Put(header, 8, CapsFlag | HeightFlag | WidthFlag | PixelFormatFlag | MipCountFlag | flag);
        Put(header, 12, height);
        Put(header, 16, width);
        Put(header, 20, pitchOrSize);
        Put(header, 24, 1);
        Put(header, 28, mips);
        Put(header, 76, 32);
        if (pixelFormat is not null)
        {
            Put(header, 80, pixelFormat.Flags);
            Encoding.ASCII.GetBytes(pixelFormat.FourCc).CopyTo(header, 84);
            Put(header, 88, pixelFormat.Bits);
            Put(header, 92, pixelFormat.Red);
            Put(header, 96, pixelFormat.Green);
            Put(header, 100, pixelFormat.Blue);
            Put(header, 104, pixelFormat.Alpha);
        }
        else
        {
            Put(header, 80, FourCcFlag);
            Encoding.ASCII.GetBytes("DX10").CopyTo(header, 84);
            Put(header, MainLength, dxgiFormat);
            Put(header, MainLength + 4, Texture2D);
            Put(header, MainLength + 12, 1);
        }

        Put(header, 108, TextureCaps | (mips > 1 ? ComplexCaps | MipmapCaps : 0));
        return header;
    }

    private sealed record LegacyPixelFormat(uint Flags, string FourCc, uint Bits = 0, uint Red = 0, uint Green = 0, uint Blue = 0, uint Alpha = 0);

    private static readonly Dictionary<byte, LegacyPixelFormat> LegacyPixelFormats = new()
    {
        [71] = new(FourCcFlag, "DXT1"),
        [74] = new(FourCcFlag, "DXT3"),
        [77] = new(FourCcFlag, "DXT5"),
        [80] = new(FourCcFlag, "BC4U"),
        [81] = new(FourCcFlag, "BC4S"),
        [83] = new(FourCcFlag, "BC5U"),
        [84] = new(FourCcFlag, "BC5S"),
        [Rgba8] = new(RgbFlag | AlphaPixelsFlag, "", 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000),
        [Bgra8] = new(RgbFlag | AlphaPixelsFlag, "", 32, 0xFF0000, 0xFF00, 0xFF, 0xFF000000),
        [R8] = new(LuminanceFlag, "", 8, 0xFF),
    };

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
        >= 48 and <= 59 or 68 or 69 or 85 or 86 or 115 => 16,
        >= 60 and <= 65 => 8,
        _ => 0,
    };

    private static byte FormatOf(byte[] header, string source)
    {
        var flags = U32(header, 80);
        if ((flags & FourCcFlag) != 0)
        {
            var fourCc = Encoding.ASCII.GetString(header, 84, 4);
            return FormatOfFourCc.TryGetValue(fourCc, out var known)
                ? known
                : throw Refusal(source, $"its pixel format '{fourCc}' has no place in an archive");
        }

        var (bits, red, green, blue, alpha) = (U32(header, 88), U32(header, 92), U32(header, 96), U32(header, 100), U32(header, 104));
        return (flags, bits, red, green, blue, alpha) switch
        {
            (_, 32, 0xFF0000, 0xFF00, 0xFF, 0xFF000000) when (flags & RgbFlag) != 0 => Bgra8,
            (_, 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000) when (flags & RgbFlag) != 0 => Rgba8,
            (_, 8, 0xFF, _, _, _) when (flags & (RgbFlag | LuminanceFlag)) != 0 => R8,
            _ => throw Refusal(source, "its pixel format has no place in an archive"),
        };
    }

    private static InvalidDataException Refusal(string source, string why) =>
        new InvalidDataException($"'{source}' cannot go into a texture archive: {why}.");

    private static uint U32(byte[] bytes, int at) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at));

    private static void Put(byte[] bytes, int at, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(at), value);
}
