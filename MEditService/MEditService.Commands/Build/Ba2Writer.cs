using System.IO.Compression;
using System.Text;
using K4os.Compression.LZ4;

namespace MEditService.Commands.Build;

internal static class Ba2Writer
{
    private const int GeneralEntryLength = 36;
    private const int TextureEntryLength = 48;
    private const uint GeneralFlags = 0x00100100;
    private const uint Unaligned = 0xBAADF00D;
    private const byte TileMode = 8;
    private const ushort TextureChunkLength = 24;
    private const uint Lz4Compression = 3;

    private static readonly uint[] CrcTable = [.. Enumerable.Range(0, 256).Select(Row)];

    private enum Codec
    {
        None,
        Zlib,
        Lz4Block,
    }

    public static void Write(Stream output, Ba2Variant variant, IReadOnlyList<PackedFile> files)
    {
        var textures = variant.Contents == Ba2Contents.Textures;
        var codec = CodecOf(variant) ?? throw new InvalidOperationException($"{variant} is not written.");
        var headerLength = variant.Version switch { 2 => 32, 3 => 36, _ => 24 };
        using var entries = new MemoryStream();
        using var entryWriter = new BinaryWriter(entries, Encoding.UTF8, leaveOpen: true);
        output.Position = headerLength + (textures ? TextureEntryLength : GeneralEntryLength) * (long)files.Count;
        foreach (var file in files)
        {
            if (textures) WriteTexture(output, entryWriter, file, codec);
            else WriteGeneral(output, entryWriter, file, codec);
        }

        var nameTable = output.Position;
        using var names = new BinaryWriter(output, Encoding.UTF8, leaveOpen: true);
        foreach (var file in files)
        {
            var name = Encoding.UTF8.GetBytes(file.Name);
            names.Write(checked((ushort)name.Length));
            names.Write(name);
        }

        output.Position = 0;
        names.Write("BTDX"u8);
        names.Write(variant.Version);
        names.Write(textures ? "DX10"u8 : "GNRL"u8);
        names.Write((uint)files.Count);
        names.Write((ulong)nameTable);
        if (variant.Version is 2 or 3) names.Write(1ul);
        if (variant.Version == 3) names.Write(Lz4Compression);
        names.Flush();
        entries.WriteTo(output);
    }

    public static bool Writes(Ba2Variant variant) => CodecOf(variant) is not null;

    private static Codec? CodecOf(Ba2Variant variant) =>
        (variant.Version, variant.Contents, variant.Compressed) switch
        {
            (1 or 2, _, false) => Codec.None,
            (1 or 2, _, true) => Codec.Zlib,
            (3, Ba2Contents.Textures, true) => Codec.Lz4Block,
            _ => null,
        };

    private static void WriteGeneral(Stream output, BinaryWriter entry, PackedFile file, Codec codec)
    {
        using var content = file.Open();
        var offset = output.Position;
        var (stored, whole) = Store(output, content, content.Length, codec);
        WriteIdentity(entry, file);
        entry.Write(GeneralFlags);
        entry.Write((ulong)offset);
        entry.Write(codec == Codec.None ? 0u : stored);
        entry.Write(whole);
        entry.Write(Unaligned);
    }

    private static void WriteTexture(Stream output, BinaryWriter entry, PackedFile file, Codec codec)
    {
        using var content = file.Open();
        var header = DdsHeader.Read(content, file.Source);
        var pixels = content.Length - header.Length;
        if (pixels <= 0) throw new InvalidDataException($"'{file.Source}' cannot go into a texture archive: it holds no pixels.");

        var offset = output.Position;
        var (stored, whole) = Store(output, content, pixels, codec);
        WriteIdentity(entry, file);
        entry.Write((byte)0);
        entry.Write((byte)1);
        entry.Write(TextureChunkLength);
        entry.Write(header.Height);
        entry.Write(header.Width);
        entry.Write(header.Mips);
        entry.Write(header.DxgiFormat);
        entry.Write((byte)(header.IsCubeMap ? 1 : 0));
        entry.Write(TileMode);
        entry.Write((ulong)offset);
        entry.Write(codec == Codec.None ? 0u : stored);
        entry.Write(whole);
        entry.Write((ushort)0);
        entry.Write((ushort)(header.Mips - 1));
        entry.Write(Unaligned);
    }

    private static (uint Stored, uint Whole) Store(Stream output, Stream content, long length, Codec codec)
    {
        var start = output.Position;
        switch (codec)
        {
            case Codec.Zlib:
                using (var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true))
                    content.CopyTo(zlib);
                break;
            case Codec.Lz4Block:
                var raw = new byte[length];
                content.ReadExactly(raw);
                var block = new byte[LZ4Codec.MaximumOutputSize(raw.Length)];
                output.Write(block, 0, LZ4Codec.Encode(raw, block, LZ4Level.L09_HC));
                break;
            default:
                content.CopyTo(output);
                break;
        }

        return (checked((uint)(output.Position - start)), checked((uint)length));
    }

    private static void WriteIdentity(BinaryWriter entry, PackedFile file)
    {
        entry.Write(Crc(file.Stem));
        var extension = Encoding.UTF8.GetBytes(file.Extension.TrimStart('.')).Take(4).ToArray();
        entry.Write(extension);
        entry.Write(new byte[4 - extension.Length]);
        entry.Write(Crc(file.Folder));
    }

    private static uint Crc(string text) =>
        Encoding.UTF8.GetBytes(text).Aggregate(0u, (crc, b) => CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8));

    private static uint Row(int index)
    {
        var crc = (uint)index;
        for (var bit = 0; bit < 8; bit++) crc = (crc & 1) != 0 ? 0xEDB88320 ^ (crc >> 1) : crc >> 1;
        return crc;
    }
}
