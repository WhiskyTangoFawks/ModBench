using System.Buffers.Binary;
using System.Text;

namespace MEditService.ModFolderAdapter;

/// <summary>The cubemap flag of each texture of a BA2, which Mutagen's reader does not expose.</summary>
internal static class Ba2Cubemaps
{
    private const int HeaderLength = 24;
    private const int EntryLength = 24;
    private const int ChunkCountAt = 13;
    private const int ChunkLengthAt = 14;
    private const int CubemapAt = 22;

    /// <summary>The forward-slash path of each cubemap in the archive at <paramref name="archiveAt"/>, in any case; none for
    /// an archive that is no texture BA2.</summary>
    internal static HashSet<string> In(string archiveAt)
    {
        HashSet<string> cubemaps = new(StringComparer.OrdinalIgnoreCase);
        var bytes = File.ReadAllBytes(archiveAt);
        if (bytes.Length < HeaderLength || !bytes.AsSpan(0, 4).SequenceEqual("BTDX"u8) || !bytes.AsSpan(8, 4).SequenceEqual("DX10"u8)) return cubemaps;

        var version = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4));
        var count = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(12));
        var names = (int)BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(16));
        var at = HeaderLength + version switch { 2 => 8, 3 => 12, _ => 0 };
        for (var entry = 0; entry < count; entry++)
        {
            var isCubemap = bytes[at + CubemapAt] != 0;
            at += EntryLength + bytes[at + ChunkCountAt] * BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(at + ChunkLengthAt));
            var length = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(names));
            if (isCubemap) cubemaps.Add(Encoding.UTF8.GetString(bytes, names + 2, length).Replace('\\', '/'));
            names += 2 + length;
        }
        return cubemaps;
    }
}
