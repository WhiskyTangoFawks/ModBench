namespace MEditService.ModFolderAdapter;

internal sealed record ArchiveEntry(string Path, long Size, Func<byte[]> Read);
