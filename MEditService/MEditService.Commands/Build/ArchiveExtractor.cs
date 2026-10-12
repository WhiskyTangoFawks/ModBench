using SharpCompress.Archives;
using SharpCompress.Common;

namespace MEditService.Commands.Build;

/// <summary>Reads the entries of a zip, 7z or rar installation file. A solid archive and any 7z are read in the one
/// forward pass SharpCompress allows them; any other is read entry by entry.</summary>
internal static class ArchiveExtractor
{
    public static void Extract(Stream archive, Action<string, long, Stream> onEntry)
    {
        using var opened = ArchiveFactory.OpenArchive(archive);
        if (opened.IsSolid || opened.Type == ArchiveType.SevenZip)
        {
            using var reader = opened.ExtractAllEntries();
            while (reader.MoveToNextEntry())
            {
                if (reader.Entry.IsDirectory || reader.Entry.Key is not { } key) continue;
                using var content = reader.OpenEntryStream();
                onEntry(key.Replace('\\', '/'), reader.Entry.Size, content);
            }
            return;
        }
        foreach (var entry in opened.Entries.Where(e => !e.IsDirectory))
        {
            if (entry.Key is not { } key) continue;
            using var content = entry.OpenEntryStream();
            onEntry(key.Replace('\\', '/'), entry.Size, content);
        }
    }
}
