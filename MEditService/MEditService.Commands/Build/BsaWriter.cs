using System.IO.Compression;
using System.Text;
using K4os.Compression.LZ4;
using K4os.Compression.LZ4.Streams;

namespace MEditService.Commands.Build;

internal static class BsaWriter
{
    private const uint LongRecordVersion = 105;
    private const uint CompressedFlag = 0x4;
    private const uint FolderAndFileNames = 0x3;
    private const uint FlagsWithoutAWriter = 0x40 | 0x100 | 0x200;
    private const int HeaderLength = 36;
    private const int FileRecordLength = 16;
    private const long CompressionFlipBit = 1 << 30;

    private static readonly Encoding Windows1252 = CodePagesEncodingProvider.Instance.GetEncoding(
        1252, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback) ?? throw new InvalidOperationException("Windows-1252 is missing.");

    private sealed record Entry(PackedFile Packed, byte[] Spelling, ulong Digest);

    private sealed record Group(byte[] Spelling, ulong Digest, List<Entry> Entries)
    {
        public int BlockLength => 1 + Spelling.Length + FileRecordLength * Entries.Count;
    }

    public static bool Writes(BsaVariant variant) =>
        variant.Version is >= 103 and <= LongRecordVersion
        && (variant.ArchiveFlags & FolderAndFileNames) == FolderAndFileNames
        && (variant.ArchiveFlags & FlagsWithoutAWriter) == 0;

    public static void Write(Stream output, BsaVariant variant, IReadOnlyList<PackedFile> files)
    {
        var folders = Groups(files);
        var fileNames = folders.SelectMany(folder => folder.Entries).Select(file => file.Spelling).ToList();
        var folderRecordLength = variant.Version == LongRecordVersion ? 24 : 16;
        var blocksStart = HeaderLength + folderRecordLength * folders.Count;
        var namesStart = blocksStart + folders.Sum(folder => folder.BlockLength);
        var fileNamesLength = fileNames.Sum(name => name.Length);

        var compressed = (variant.ArchiveFlags & CompressedFlag) != 0;
        output.Position = namesStart + fileNamesLength;
        var stored = folders.SelectMany(folder => folder.Entries).Select(file => Store(output, file.Packed, variant.Version, compressed)).ToList();

        using var head = new MemoryStream();
        using var writer = new BinaryWriter(head, Encoding.UTF8, leaveOpen: true);
        writer.Write("BSA\0"u8);
        writer.Write(variant.Version);
        writer.Write((uint)HeaderLength);
        writer.Write(variant.ArchiveFlags);
        writer.Write((uint)folders.Count);
        writer.Write((uint)files.Count);
        writer.Write((uint)folders.Sum(folder => folder.Spelling.Length));
        writer.Write((uint)fileNamesLength);
        writer.Write(variant.FileFlags);

        var blockStart = blocksStart;
        foreach (var folder in folders)
        {
            writer.Write(folder.Digest);
            writer.Write((uint)folder.Entries.Count);
            var offset = blockStart + fileNamesLength;
            if (variant.Version == LongRecordVersion)
            {
                writer.Write(0u);
                writer.Write((ulong)offset);
            }
            else
            {
                writer.Write((uint)offset);
            }

            blockStart += folder.BlockLength;
        }

        var next = 0;
        foreach (var folder in folders)
        {
            writer.Write((byte)folder.Spelling.Length);
            writer.Write(folder.Spelling);
            foreach (var file in folder.Entries)
            {
                writer.Write(file.Digest);
                writer.Write(stored[next].Size);
                writer.Write(stored[next].Offset);
                next++;
            }
        }

        foreach (var name in fileNames) writer.Write(name);

        output.Position = 0;
        head.WriteTo(output);
    }

    private static List<Group> Groups(IReadOnlyList<PackedFile> files)
    {
        var folders = files
            .GroupBy(file => file.Folder)
            .Select(group => new Group(
                Terminated(group.Key, group.First()),
                Hash(group.Key, string.Empty),
                [.. group.Select(file => new Entry(file, Terminated(file.FileName, file), Hash(file.Stem, file.Extension))).OrderBy(file => file.Digest)]))
            .OrderBy(folder => folder.Digest)
            .ToList();
        if (folders.Any(folder => folder.Spelling.Length > byte.MaxValue))
            throw new InvalidDataException("A BSA folder's name is at most 254 characters.");
        RefuseSameHash(folders.Select(folder => (folder.Digest, folder.Entries[0].Packed)), "folders");
        foreach (var folder in folders) RefuseSameHash(folder.Entries.Select(file => (file.Digest, file.Packed)), "files");
        return folders;
    }

    private static void RefuseSameHash(IEnumerable<(ulong Hash, PackedFile File)> hashed, string what)
    {
        var same = hashed.GroupBy(h => h.Hash).FirstOrDefault(group => group.Count() > 1);
        if (same is not null)
            throw new InvalidDataException($"A BSA tells {what} apart by hash, and {string.Join(" and ", same.Select(h => $"'{h.File.Source}'"))} hash alike.");
    }

    private static byte[] Terminated(string name, PackedFile file)
    {
        try
        {
            return [.. Windows1252.GetBytes(name), 0];
        }
        catch (EncoderFallbackException)
        {
            throw new InvalidDataException($"'{file.Source}' has characters a BSA cannot spell.");
        }
    }

    private static (uint Size, uint Offset) Store(Stream output, PackedFile file, uint version, bool compressed)
    {
        using var content = file.Open();
        var offset = checked((uint)output.Position);
        RefuseASizeTheFlagBitReads(file, content.Length);
        if (!compressed)
        {
            content.CopyTo(output);
            return ((uint)content.Length, offset);
        }

        using (var writer = new BinaryWriter(output, Encoding.UTF8, leaveOpen: true))
            writer.Write(checked((uint)content.Length));
        if (version == LongRecordVersion)
        {
            using var lz4 = LZ4Stream.Encode(output, new LZ4EncoderSettings { CompressionLevel = LZ4Level.L09_HC }, leaveOpen: true);
            content.CopyTo(lz4);
        }
        else
        {
            using var zlib = new ZLibStream(output, CompressionLevel.Optimal, leaveOpen: true);
            content.CopyTo(zlib);
        }

        var stored = output.Position - offset;
        RefuseASizeTheFlagBitReads(file, stored);
        return ((uint)stored, offset);
    }

    private static void RefuseASizeTheFlagBitReads(PackedFile file, long size)
    {
        if (size >= CompressionFlipBit)
            throw new InvalidDataException($"'{file.Source}' is too large for a BSA: a size of 1 GiB or more reads as a compression flag.");
    }

    private static ulong Hash(string name, string extension)
    {
        if (name.Length == 0) return 0;
        var chars = Windows1252.GetBytes(name);
        var low = chars[^1] | (chars.Length >= 3 ? (uint)chars[^2] << 8 : 0) | (uint)(byte)chars.Length << 16 | (uint)chars[0] << 24;
        low |= extension switch
        {
            ".kf" => 0x80u,
            ".nif" => 0x8000u,
            ".dds" => 0x8080u,
            ".wav" => 0x80000000u,
            _ => 0u,
        };
        var high = Polynomial(chars.AsSpan(1..Math.Max(1, chars.Length - 2))) + Polynomial(Windows1252.GetBytes(extension));
        return ((ulong)high << 32) + low;
    }

    private static uint Polynomial(ReadOnlySpan<byte> bytes)
    {
        var hash = 0u;
        foreach (var b in bytes) hash = unchecked(hash * 0x1003f + b);
        return hash;
    }
}
