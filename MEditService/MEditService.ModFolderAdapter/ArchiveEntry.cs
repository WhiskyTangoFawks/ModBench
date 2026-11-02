namespace MEditService.ModFolderAdapter;

internal sealed record ArchiveEntry(string Path, bool IsCubemap, Func<byte[]> Read);
