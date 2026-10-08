namespace MEditService.TestSupport;

public static class FolderEntries
{
    /// <summary>Every file and folder beneath <paramref name="folder"/>, relative and sorted: what the user sees in it.</summary>
    public static string[] Of(string folder) =>
        [.. Directory.EnumerateFileSystemEntries(folder, "*", SearchOption.AllDirectories)
            .Select(entry => Path.GetRelativePath(folder, entry))
            .Order(StringComparer.Ordinal)];

    /// <summary>The one folder-level entry <paramref name="folder"/> holds now and did not in <paramref name="before"/>, as a full path.</summary>
    public static string TheOneAddedTo(string folder, IEnumerable<string> before) =>
        Path.Combine(folder, Assert.Single(Of(folder).Except(before), entry => !entry.Contains(Path.DirectorySeparatorChar)));
}
