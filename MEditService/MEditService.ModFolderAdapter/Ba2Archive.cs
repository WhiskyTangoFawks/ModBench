// Follows Wabbajack's BA2 reader (GPL-3), upstream main at bc126071:
// https://github.com/wabbajack-tools/wabbajack, Wabbajack.Compression.BSA/BA2Archive.
// Modified by Modbench in November 2026.
using System.IO.Compression;
using System.Text;
using K4os.Compression.LZ4;

namespace MEditService.ModFolderAdapter;

internal static class Ba2Archive
{
    private sealed record Chunk(ulong Offset, uint Stored, uint Whole);

    public static bool IsBa2(string archiveAt)
    {
        using var file = File.OpenRead(archiveAt);
        Span<byte> magic = stackalloc byte[4];
        return file.ReadAtLeast(magic, 4, throwOnEndOfStream: false) == 4 && magic.SequenceEqual("BTDX"u8);
    }

    /// <summary>Every entry of the BA2 at <paramref name="archiveAt"/>; it throws when the archive is not one Modbench reads.</summary>
    public static IReadOnlyList<ArchiveEntry> Read(string archiveAt)
    {
        using var file = File.OpenRead(archiveAt);
        using var reader = new BinaryReader(file, Encoding.UTF8);
        if (!reader.ReadBytes(4).AsSpan().SequenceEqual("BTDX"u8)) throw new InvalidDataException("it is no BA2");

        var version = reader.ReadUInt32();
        if (version is not (1 or 2 or 3 or 7 or 8)) throw new InvalidDataException($"its BA2 is version {version}, which is not read");
        var kind = Encoding.ASCII.GetString(reader.ReadBytes(4));
        var count = reader.ReadUInt32();
        var nameTable = reader.ReadInt64();
        if (version is 2 or 3) reader.ReadUInt64();
        var codec = Ba2Codec.Zlib;
        if (version == 3)
        {
            var compression = reader.ReadUInt32();
            codec = compression switch
            {
                0 => Ba2Codec.Zlib,
                Ba2Format.Lz4Compression => Ba2Codec.Lz4Block,
                _ => throw new InvalidDataException($"its compression {compression} is not read"),
            };
        }

        var layouts = kind switch
        {
            "GNRL" => Enumerable.Range(0, (int)count).Select(_ => ReadGeneral(reader, archiveAt, codec)).ToList(),
            "DX10" => Enumerable.Range(0, (int)count).Select(_ => ReadTexture(reader, archiveAt, codec)).ToList(),
            _ => throw new InvalidDataException($"its BA2 holds '{kind}' entries, which are not read"),
        };

        if (nameTable <= 0 || nameTable >= file.Length) throw new InvalidDataException("it has no name table");
        file.Position = nameTable;
        return [.. layouts.Select(layout => layout with { Path = Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadUInt16())).Replace('\\', '/') })];
    }

    private static ArchiveEntry ReadGeneral(BinaryReader reader, string archiveAt, Ba2Codec codec)
    {
        reader.ReadBytes(12);
        reader.ReadUInt32();
        var chunk = new Chunk(reader.ReadUInt64(), reader.ReadUInt32(), reader.ReadUInt32());
        reader.ReadUInt32();
        return new ArchiveEntry("", () => Inflated(archiveAt, chunk, codec));
    }

    private static ArchiveEntry ReadTexture(BinaryReader reader, string archiveAt, Ba2Codec codec)
    {
        reader.ReadBytes(12);
        reader.ReadByte();
        var chunkCount = reader.ReadByte();
        reader.ReadUInt16();
        var height = reader.ReadUInt16();
        var width = reader.ReadUInt16();
        var mips = reader.ReadByte();
        var format = reader.ReadByte();
        var isCubemap = reader.ReadByte() != 0;
        reader.ReadByte();
        var chunks = Enumerable.Range(0, chunkCount).Select(_ =>
        {
            var chunk = new Chunk(reader.ReadUInt64(), reader.ReadUInt32(), reader.ReadUInt32());
            reader.ReadBytes(Ba2Format.TextureChunkLength - 16);
            return chunk;
        }).ToList();
        return new ArchiveEntry("", () =>
            [.. DdsHeaderWriter.Write(width, height, mips, format, isCubemap), .. chunks.SelectMany(chunk => Inflated(archiveAt, chunk, codec))]);
    }

    private static byte[] Inflated(string archiveAt, Chunk chunk, Ba2Codec codec)
    {
        using var file = File.OpenRead(archiveAt);
        file.Position = (long)chunk.Offset;
        var whole = new byte[chunk.Whole];
        if (chunk.Stored == 0)
        {
            file.ReadExactly(whole);
            return whole;
        }

        var stored = new byte[chunk.Stored];
        file.ReadExactly(stored);
        if (codec == Ba2Codec.Lz4Block)
        {
            if (LZ4Codec.Decode(stored, whole) != whole.Length) throw new InvalidDataException("an LZ4 entry inflates to another size than it records");
            return whole;
        }

        using var zlib = new ZLibStream(new MemoryStream(stored), CompressionMode.Decompress);
        zlib.ReadExactly(whole);
        if (zlib.ReadByte() != -1) throw new InvalidDataException("a zlib entry inflates to another size than it records");
        return whole;
    }
}
