using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>A file in a mod folder as the file system describes it, without a read of its bytes. The stamp is
/// null when the file system cannot answer, and then nothing vouches for a remembered hash.</summary>
public sealed record ModFile(string Path, FileStamp? Stamp);
