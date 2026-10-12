using System.IO.Compression;
using System.Text;

namespace MEditService.Commands.Build;

/// <summary>Writes the Fallout 4 form of a BA2 (version 1), general or texture. Its layout and its hashes are read
/// off the game's own archives; no other version is written.</summary>
internal static class Ba2Writer
{
    private const uint SupportedVersion = 1;
    private const int HeaderLength = 24;
    private const int GeneralEntryLength = 36;
    private const int TextureEntryLength = 48;
    private const uint GeneralFlags = 0x00100100;
    private const uint Unaligned = 0xBAADF00D;
    private const byte TileMode = 8;
    private const ushort TextureChunkLength = 24;

    private static readonly uint[] CrcTable = [.. Enumerable.Range(0, 256).Select(Row)];

    public static void Write(Stream output, Ba2Variant variant, IReadOnlyList<PackedFile> files)
    {
        if (variant.Version != SupportedVersion) throw new NotSupportedException($"BA2 version {variant.Version} is not written.");

        var textures = variant.Contents == Ba2Contents.Textures;
        using var entries = new MemoryStream();
        using var entryWriter = new BinaryWriter(entries, Encoding.UTF8, leaveOpen: true);
        output.Position = HeaderLength + (textures ? TextureEntryLength : GeneralEntryLength) * (long)files.Count;
        foreach (var file in files)
        {
            if (textures) WriteTexture(output, entryWriter, file, variant.Compressed);
            else WriteGeneral(output, entryWriter, file, variant.Compressed);
        }

        var nameTable = output.Position;
        using var names = new BinaryWriter(output, Encoding.UTF8, leaveOpen: true);
        foreach (var file in files)
        {
            var name = Encoding.UTF8.GetBytes(file.Name);
            names.Write(checked((ushort)name.Length));
            names.Write(name);
        }

        names.Flush();
        output.Position = 0;
        names.Write("BTDX"u8);
        names.Write(SupportedVersion);
        names.Write(textures ? "DX10"u8 : "GNRL"u8);
        names.Write((uint)files.Count);
        names.Write((ulong)nameTable);
        entries.WriteTo(output);
    }

    private static void WriteGeneral(Stream output, BinaryWriter entry, PackedFile file, bool compressed)
    {
        using var content = file.Open();
        var offset = output.Position;
        var (stored, whole) = Store(output, content, content.Length, compressed);
        WriteIdentity(entry, file);
        entry.Write(GeneralFlags);
        entry.Write((ulong)offset);
        entry.Write(compressed ? stored : 0u);
        entry.Write(whole);
        entry.Write(Unaligned);
    }

    private static void WriteTexture(Stream output, BinaryWriter entry, PackedFile file, bool compressed)
    {
        using var content = file.Open();
        var header = DdsHeader.Read(content, file.Source);
        var pixels = content.Length - header.Length;
        if (pixels <= 0) throw new InvalidDataException($"'{file.Source}' cannot go into a texture archive: it holds no pixels.");

        var offset = output.Position;
        var (stored, whole) = Store(output, content, pixels, compressed);
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
        entry.Write(compressed ? stored : 0u);
        entry.Write(whole);
        entry.Write((ushort)0);
        entry.Write((ushort)(header.Mips - 1));
        entry.Write(Unaligned);
    }

    private static (uint Stored, uint Whole) Store(Stream output, Stream content, long length, bool compressed)
    {
        var start = output.Position;
        if (compressed)
        {
            using var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true);
            content.CopyTo(zlib);
        }
        else
        {
            content.CopyTo(output);
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
