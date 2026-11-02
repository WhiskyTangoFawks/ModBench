namespace MEditService.ModFolderAdapter;

internal sealed record ArchiveEntry(string Path, Func<byte[]> Read);
