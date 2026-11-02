using System.Text;

namespace MEditService.ModFolderAdapter;

/// <summary>The cubemap flag of each texture of a BA2, which Mutagen's reader does not expose.</summary>
public static class Ba2Cubemaps
{
    private const int FileHeaderLength = 24;
    private const int ChunkLength = 24;
    private const int ChunkCountAt = 13;
    private const int FlagsAt = 22;
    private const int EntryHeadLength = 24;
    private const byte CubemapFlag = 0x01;

    /// <summary>The forward-slash path of each cubemap in the archive, in any case; none for an archive that is no texture
    /// BA2. Throws <see cref="InvalidDataException"/> for a texture BA2 of a version whose layout is not known.</summary>
    public static HashSet<string> In(string archiveAt)
    {
        HashSet<string> cubemaps = new(StringComparer.OrdinalIgnoreCase);
        using var file = File.OpenRead(archiveAt);
        using var reader = new BinaryReader(file, Encoding.UTF8);
        if (file.Length < FileHeaderLength || !reader.ReadBytes(4).AsSpan().SequenceEqual("BTDX"u8)) return cubemaps;

        var version = reader.ReadUInt32();
        if (!reader.ReadBytes(4).AsSpan().SequenceEqual("DX10"u8)) return cubemaps;

        var firstEntry = FileHeaderLength + version switch
        {
            1 or 7 or 8 => 0,
            2 => 8,
            3 => 12,
            _ => throw new InvalidDataException($"its texture BA2 is version {version}, whose layout Modbench does not know"),
        };
        var count = reader.ReadUInt32();
        var nameTable = reader.ReadInt64();
        if (nameTable <= 0 || nameTable >= file.Length) return cubemaps;

        List<bool> isCubemap = [];
        file.Position = firstEntry;
        for (var entry = 0; entry < count; entry++)
        {
            var head = reader.ReadBytes(EntryHeadLength);
            isCubemap.Add((head[FlagsAt] & CubemapFlag) != 0);
            file.Position += head[ChunkCountAt] * ChunkLength;
        }

        file.Position = nameTable;
        foreach (var cube in isCubemap)
        {
            var name = Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadUInt16()));
            if (cube) cubemaps.Add(name.Replace('\\', '/'));
        }
        return cubemaps;
    }
}
