using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>A file by its path and the stamp the file system gave it, without a read of its bytes.</summary>
public sealed record StampedFile(string Path, FileStamp? Stamp);

/// <summary>A file of a mod folder with its hash, and the stamp that vouches for the hash: null when the file
/// changed too recently to trust, or the file system gave none.</summary>
public sealed record HashedFile(string Path, string Hash, FileStamp? Stamp);
