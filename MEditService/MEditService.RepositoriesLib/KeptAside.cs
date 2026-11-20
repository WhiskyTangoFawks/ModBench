namespace MEditService.RepositoriesLib;

/// <summary>Folders a write sets files aside in, in place of overwriting them, each kept until the extension trashes what it holds,
/// across a restart of mEdit. A purpose of its own keeps one write's from another's.</summary>
public sealed class KeptAside(string purpose)
{
    private readonly string _start = TempName.KeptStart(purpose);

    /// <summary>A new folder in <paramref name="folder"/> to set files aside in.</summary>
    public string NewFolderIn(string folder) => Path.Combine(folder, _start + Path.GetRandomFileName());

    /// <summary>What each folder in <paramref name="folder"/> holds, by its forward-slash path in it, else the folder itself.</summary>
    public IReadOnlyList<string> In(string folder) =>
        Directory.Exists(folder)
            ? [.. Directory.EnumerateDirectories(folder, _start + "*").Order(StringComparer.Ordinal).SelectMany(aside =>
                Directory.EnumerateFileSystemEntries(aside).Order(StringComparer.Ordinal)
                    .Select(entry => Path.GetRelativePath(folder, entry).Replace('\\', '/'))
                    .DefaultIfEmpty(Path.GetFileName(aside)))]
            : [];
}
