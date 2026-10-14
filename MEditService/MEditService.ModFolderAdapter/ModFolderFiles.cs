namespace MEditService.ModFolderAdapter;

/// <summary>A mod folder's files with their hashes, and why the stat cache could not keep what the read found, or null.
/// Every file was read all the same.</summary>
public sealed record ModFolderFiles(IReadOnlyList<HashedFile> Files, string? StatCacheNotWritten);
