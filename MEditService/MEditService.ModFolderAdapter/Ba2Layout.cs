using System.Text;

namespace MEditService.ModFolderAdapter;

/// <summary>What Modbench reads of a BA2 beside Mutagen: the refusal of a version Mutagen's reader is not shown to read
/// correctly, and the cubemap textures, a flag Mutagen does not expose.</summary>
internal sealed record Ba2Layout(ArchiveStepRefusal? Refusal, IReadOnlySet<string> Cubemaps)
{
    private const int FileHeaderLength = 24;
    private const int ChunkLength = 24;
    private const int ChunkCountAt = 13;
    private const int FlagsAt = 22;
    private const int EntryHeadLength = 24;
    private const byte CubemapFlag = 0x01;

    private static readonly IReadOnlySet<string> NoCubemaps = new HashSet<string>();

    /// <summary>An archive that is no BA2 has no refusal and no cubemaps. Cubemaps are read where the version's entry layout is known.</summary>
    public static Ba2Layout Read(string archiveAt)
    {
        using var file = File.OpenRead(archiveAt);
        using var reader = new BinaryReader(file, Encoding.UTF8);
        if (file.Length < FileHeaderLength || !reader.ReadBytes(4).AsSpan().SequenceEqual("BTDX"u8)) return new Ba2Layout(null, NoCubemaps);

        var version = reader.ReadUInt32();
        var textures = reader.ReadBytes(4).AsSpan().SequenceEqual("DX10"u8);
        var refusal = ReadCorrectly(version, textures) ? null : NotReadCorrectly(version, textures);
        if (!textures || version is not (1 or 2 or 3 or 7 or 8)) return new Ba2Layout(refusal, NoCubemaps);

        var firstEntry = FileHeaderLength + version switch { 2 => 8, 3 => 12, _ => 0 };
        var count = reader.ReadUInt32();
        var nameTable = reader.ReadInt64();
        if (nameTable <= 0 || nameTable >= file.Length) return new Ba2Layout(refusal, NoCubemaps);

        List<bool> isCubemap = [];
        file.Position = firstEntry;
        for (var entry = 0; entry < count; entry++)
        {
            var head = reader.ReadBytes(EntryHeadLength);
            isCubemap.Add((head[FlagsAt] & CubemapFlag) != 0);
            file.Position += head[ChunkCountAt] * ChunkLength;
        }

        HashSet<string> cubemaps = new(StringComparer.OrdinalIgnoreCase);
        file.Position = nameTable;
        foreach (var cube in isCubemap)
        {
            var name = Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadUInt16()));
            if (cube) cubemaps.Add(name.Replace('\\', '/'));
        }
        return new Ba2Layout(refusal, cubemaps);
    }

    // Compared file for file with TES5Edit's layout on installed archives: version 1, and version 2 or 8 when general.
    private static bool ReadCorrectly(uint version, bool textures) => version == 1 || (version is 2 or 8 && !textures);

    private static ArchiveStepRefusal NotReadCorrectly(uint version, bool textures) => new(
        ArchiveRefusal.ArchiveUnreadable,
        $"its {(textures ? "texture" : "general")} BA2 is version {version}, which Mutagen's reader is not shown to read correctly");
}
