using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;

namespace MEditService.ModFolderAdapter;

/// <summary>What the archive at <paramref name="Archive"/> holds: each file's forward-slash path, or none and why it could not be read.</summary>
public sealed record ArchiveContents(string Archive, IReadOnlyList<string> Files, string? Unreadable);

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

    internal static IEnumerable<ArchiveEntry> EntriesOf(GameRelease release, string archiveAt) =>
        Ba2Archive.IsBa2(archiveAt)
            ? Ba2Archive.Read(archiveAt)
            : Archive.CreateReader(release, archiveAt).Files.Select(entry => new ArchiveEntry(entry.Path.Replace('\\', '/'), entry.GetBytes));
}
