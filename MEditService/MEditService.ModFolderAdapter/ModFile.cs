namespace MEditService.ModFolderAdapter;

/// <summary>A file in a mod folder as the file system describes it, without a read of its bytes.</summary>
public sealed record ModFile(string Path, long Size, DateTime Modified);
