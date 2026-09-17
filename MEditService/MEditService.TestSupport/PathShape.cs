namespace MEditService.Tests.TestSupport;

/// <summary>The parent of a path a fixture already knows names a file, so an assertion reads the folder without a null check of its own.</summary>
public static class PathShape
{
    /// <summary>The parent directory of <paramref name="path"/>. Throws when it has none — the
    /// caller's claim that the path names a file was false.</summary>
    public static string DirectoryOf(string path) =>
        Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory.");
}
