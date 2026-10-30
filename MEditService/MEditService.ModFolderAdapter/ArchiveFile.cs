namespace MEditService.ModFolderAdapter;

public sealed record ArchiveFile(string Path, Func<Stream> Open);
