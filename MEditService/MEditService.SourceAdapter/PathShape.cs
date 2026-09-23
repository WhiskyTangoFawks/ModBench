namespace MEditService.SourceAdapter;

/// <summary>The folder a source document or a git work tree sits in, for a path this box already knows names a file.</summary>
internal static class PathShape
{
    /// <summary>The parent directory of <paramref name="path"/>. Throws when it has none — the
    /// caller's claim that the path names a file was false.</summary>
    internal static string DirectoryOf(string path) =>
        Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory.");
}
