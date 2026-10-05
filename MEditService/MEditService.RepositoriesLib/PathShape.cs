namespace MEditService.RepositoriesLib;

/// <summary>The folder a path sits in, for a path the caller already knows names a file.</summary>
public static class PathShape
{
    /// <summary>The parent directory of <paramref name="path"/>. Throws when it has none — the
    /// caller's claim that the path names a file was false.</summary>
    public static string DirectoryOf(string path) =>
        Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory.");
}
