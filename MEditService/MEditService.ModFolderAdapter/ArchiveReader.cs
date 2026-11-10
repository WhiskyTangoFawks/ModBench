using System.Buffers.Binary;
using System.IO.Hashing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;

namespace MEditService.ModFolderAdapter;

/// <summary>What the archive at <paramref name="Archive"/> holds: each file's forward-slash path, or none and why it could not be read.</summary>
public sealed record ArchiveContents(string Archive, IReadOnlyList<string> Files, string? Unreadable);

/// <summary>A file in an archive, by the path it was asked for: its size in bytes, as the archive's index records it, and
/// when asked for, the xxHash64 of its bytes as the extension writes a loose file's, its eight little-endian bytes in base64.</summary>
public sealed record ArchivedCopy(string File, long Size, string? Hash);

public static class ArchiveReader
{
    public static ArchiveContents Contents(GameRelease release, string archiveAt)
    {
        try
        {
            return new ArchiveContents(archiveAt, [.. EntriesOf(release, archiveAt).Select(entry => entry.Path)], null);
        }
        catch (Exception e) when (e is not (OperationCanceledException or OutOfMemoryException))
        {
            return new ArchiveContents(archiveAt, [], e.Message);
        }
    }

    /// <summary>The bytes of <paramref name="file"/> in the archive, or none when the archive holds no such file. Throws when the archive cannot be read.</summary>
    public static byte[]? FileBytes(GameRelease release, string archiveAt, string file) =>
        EntriesOf(release, archiveAt).FirstOrDefault(entry => string.Equals(entry.Path, file, StringComparison.OrdinalIgnoreCase))?.Read();

    /// <summary>Each of <paramref name="files"/> the archive holds, its index read once, and each file's bytes only when
    /// <paramref name="hashed"/>. Throws when the archive cannot be read.</summary>
    public static IReadOnlyList<ArchivedCopy> Copies(GameRelease release, string archiveAt, IReadOnlyList<string> files, bool hashed)
    {
        var entries = EntriesOf(release, archiveAt).ToLookup(entry => entry.Path, StringComparer.OrdinalIgnoreCase);
        return [.. files.Where(entries.Contains).Select(file =>
        {
            var entry = entries[file].First();
            return new ArchivedCopy(file, entry.Size, hashed ? DigestOf(entry.Read()) : null);
        })];
    }

    private static string DigestOf(byte[] bytes)
    {
        var digest = new byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(digest, XxHash64.HashToUInt64(bytes));
        return Convert.ToBase64String(digest);
    }

    internal static IEnumerable<ArchiveEntry> EntriesOf(GameRelease release, string archiveAt) =>
        Ba2Archive.IsBa2(archiveAt)
            ? Ba2Archive.Read(archiveAt)
            : Archive.CreateReader(release, archiveAt).Files.Select(entry => new ArchiveEntry(entry.Path.Replace('\\', '/'), entry.Size, entry.GetBytes));
}
