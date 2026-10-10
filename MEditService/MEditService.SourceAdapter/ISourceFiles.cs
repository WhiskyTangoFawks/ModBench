namespace MEditService.SourceAdapter;

/// <summary>The files a repository reads its tree from: the disk's, or a session's changes over them. Each
/// answers and throws as the file system's own call does.</summary>
internal interface ISourceFiles
{
    bool FileExists(string path);

    bool DirectoryExists(string path);

    byte[] ReadAllBytes(string path);

    string ReadAllText(string path);

    /// <summary>Whether reading <paramref name="path"/> answers text VS Code holds unsaved, not the file's.</summary>
    bool HoldsUnsavedText(string path);

    IEnumerable<string> EntriesUnder(string directory);

    IEnumerable<string> FilesIn(string directory, string pattern, SearchOption option);

    IEnumerable<string> DirectoriesIn(string directory);
}

internal sealed class DiskFiles : ISourceFiles
{
    internal static readonly DiskFiles Instance = new();

    private DiskFiles()
    {
    }

    public bool FileExists(string path) => File.Exists(path);

    public bool DirectoryExists(string path) => Directory.Exists(path);

    public byte[] ReadAllBytes(string path) => File.ReadAllBytes(path);

    public string ReadAllText(string path) => File.ReadAllText(path);

    public bool HoldsUnsavedText(string path) => false;

    public IEnumerable<string> EntriesUnder(string directory) =>
        Directory.EnumerateFileSystemEntries(directory, "*", SearchOption.AllDirectories);

    public IEnumerable<string> FilesIn(string directory, string pattern, SearchOption option) =>
        Directory.EnumerateFiles(directory, pattern, option);

    public IEnumerable<string> DirectoriesIn(string directory) => Directory.EnumerateDirectories(directory);
}
