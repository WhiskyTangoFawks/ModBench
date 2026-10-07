namespace MEditService.TestSupport;

public static class FolderEntries
{
    /// <summary>Every file and folder beneath <paramref name="folder"/>, relative and sorted: what the user sees in it.</summary>
    public static string[] Of(string folder) =>
        [.. Directory.EnumerateFileSystemEntries(folder, "*", SearchOption.AllDirectories)
            .Select(entry => Path.GetRelativePath(folder, entry))
            .Order(StringComparer.Ordinal)];
}
