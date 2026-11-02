using Mutagen.Bethesda;
using Mutagen.Bethesda.Archives;

namespace MEditService.ModFolderAdapter;

public static class ArchiveUnpacker
{
    /// <summary>Each of <paramref name="files"/>, by its forward-slash path and without regard to case, out of the archive at
    /// <paramref name="archiveAt"/>; the refusal when any is not unpacked.</summary>
    public static PackRefusal? Unpack(GameRelease release, string archiveAt, IReadOnlyList<string> files, out IReadOnlyList<ArchiveFile> unpacked)
    {
        unpacked = [];
        try
        {
            var entries = Archive.CreateReader(release, archiveAt).Files
                .ToLookup(entry => entry.Path.Replace('\\', '/'), StringComparer.OrdinalIgnoreCase);
            var missing = files.Where(file => !entries.Contains(file)).ToList();
            if (missing.Count > 0)
                return new PackRefusal(ArchiveRefusal.FileNotInArchive, $"'{archiveAt}' holds no {string.Join(" or ", missing.Select(file => $"'{file}'"))}.");

            var cubemaps = Ba2Cubemaps.In(archiveAt);
            var cube = files.Where(file => cubemaps.Contains(file)).ToList();
            if (cube.Count > 0)
                return new PackRefusal(ArchiveRefusal.CubemapNotUnpackable, $"{string.Join(" and ", cube.Select(file => $"'{file}'"))} is a cubemap, and Mutagen's extraction drops its cubemap flag.");

            unpacked = [.. files.Select(file => new ArchiveFile(file, () => new MemoryStream(entries[file].First().GetBytes())))];
            return null;
        }
        catch (Exception e) when (e is IOException or InvalidDataException or UnauthorizedAccessException or NotSupportedException or NotImplementedException or ArgumentException or OverflowException)
        {
            return new PackRefusal(ArchiveRefusal.ArchiveUnreadable, $"'{archiveAt}' could not be read: {e.Message}");
        }
    }
}
