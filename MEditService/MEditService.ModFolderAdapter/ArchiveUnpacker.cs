using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;

namespace MEditService.ModFolderAdapter;

public static class ArchiveUnpacker
{
    /// <summary>Each of <paramref name="files"/>, by its forward-slash path and without regard to case, out of the archive at
    /// <paramref name="archiveAt"/>; the refusal when any is not unpacked.</summary>
    public static ArchiveStepRefusal? Unpack(GameRelease release, string archiveAt, IReadOnlyList<string> files, out IReadOnlyList<ArchiveFile> unpacked)
    {
        unpacked = [];
        try
        {
            var entries = EntriesOf(release, archiveAt).ToLookup(entry => entry.Path, StringComparer.OrdinalIgnoreCase);
            var missing = files.Where(file => !entries.Contains(file)).ToList();
            if (missing.Count > 0)
                return new ArchiveStepRefusal(ArchiveRefusal.FileNotInArchive, $"'{archiveAt}' holds no {string.Join(" or ", missing.Select(file => $"'{file}'"))}.");

            var ambiguous = files.Select(file => entries[file].ToList()).FirstOrDefault(named => named.Count > 1);
            if (ambiguous is not null)
                return new ArchiveStepRefusal(ArchiveRefusal.EntriesAmbiguous, $"'{archiveAt}' holds {string.Join(" and ", ambiguous.Select(entry => $"'{entry.Path}'"))}, which are one file without regard to case.");

            var cube = files.Where(file => entries[file].Single().IsCubemap).ToList();
            if (cube.Count > 0)
                return new ArchiveStepRefusal(ArchiveRefusal.CubemapNotUnpackable, $"{string.Join(" and ", cube.Select(file => $"'{file}'"))} is a cubemap, and its DDS header would drop the cubemap flag.");

            unpacked = [.. files.Select(file => new ArchiveFile(file, MemoryOf(entries[file].Single().Read())))];
            return null;
        }
        catch (Exception e) when (e is not (OperationCanceledException or OutOfMemoryException))
        {
            return new ArchiveStepRefusal(ArchiveRefusal.ArchiveUnreadable, $"'{archiveAt}' could not be read: {e.Message}");
        }
    }

    private static IEnumerable<ArchiveEntry> EntriesOf(GameRelease release, string archiveAt) =>
        Ba2Archive.IsBa2(archiveAt)
            ? Ba2Archive.Read(archiveAt)
            : Archive.CreateReader(release, archiveAt).Files.Select(entry => new ArchiveEntry(entry.Path.Replace('\\', '/'), false, entry.GetBytes));

    private static Func<Stream> MemoryOf(byte[] bytes) => () => new MemoryStream(bytes);
}
