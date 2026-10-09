using System.Text;

namespace MEditService.SourceAdapter;

/// <summary>The disk's files, each of <paramref name="unsaved"/>'s texts read in place of the file at its path.
/// A text stands in for a file; it makes none.</summary>
internal sealed class UnsavedFiles(IEnumerable<DocumentChange> unsaved) : ISourceFiles
{
    private readonly IReadOnlyList<DocumentChange> _unsaved =
        [.. unsaved.Select(document => document with { Path = Path.GetFullPath(document.Path) })];

    public bool FileExists(string path) => DiskFiles.Instance.FileExists(path);

    public bool DirectoryExists(string path) => DiskFiles.Instance.DirectoryExists(path);

    public byte[] ReadAllBytes(string path) =>
        UnsavedText(path) is { } text ? Encoding.UTF8.GetBytes(text) : DiskFiles.Instance.ReadAllBytes(path);

    public string ReadAllText(string path) => UnsavedText(path) ?? DiskFiles.Instance.ReadAllText(path);

    public bool HoldsUnsavedText(string path) => FileExists(path) && UnsavedText(path) is not null;

    public IEnumerable<string> EntriesUnder(string directory) => DiskFiles.Instance.EntriesUnder(directory);

    public IEnumerable<string> FilesIn(string directory, string pattern, SearchOption option) =>
        DiskFiles.Instance.FilesIn(directory, pattern, option);

    public IEnumerable<string> DirectoriesIn(string directory) => DiskFiles.Instance.DirectoriesIn(directory);

    private string? UnsavedText(string path)
    {
        var full = Path.GetFullPath(path);
        return _unsaved.FirstOrDefault(document => string.Equals(document.Path, full, SourceRepositoryLocator.PathComparison))?.Text;
    }
}
