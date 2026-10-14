namespace MEditService.ModFolderAdapter;

/// <summary>A mod folder's files with their hashes, and the stat cache the read went through.</summary>
public sealed record ModFolderFiles(IReadOnlyList<HashedFile> Files)
{
    internal StatCache? StatCache { get; init; }
}
