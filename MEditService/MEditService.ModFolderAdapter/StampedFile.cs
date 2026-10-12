using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>A file by its path and the stamp the file system gave it, without a read of its bytes.</summary>
public sealed record StampedFile(string Path, FileStamp? Stamp);
