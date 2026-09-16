namespace MEditService.LoadOrder;

/// <summary>Path-shape invariants for a path the caller already knows names a file, unlike
/// <see cref="LoadOrderSnapshot.ModFolderOf(string, string)"/>, whose null is a real state.</summary>
public static class PathShape
{
    /// <summary>The parent directory of <paramref name="path"/>. Throws when it has none — the
    /// caller's claim that the path names a file was false.</summary>
    public static string DirectoryOf(string path) =>
        Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory.");
}
