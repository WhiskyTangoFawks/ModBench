using System.Buffers.Binary;
using System.Text;

namespace MEditService.Commands.Build;

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
}
