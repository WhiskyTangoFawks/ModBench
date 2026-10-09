using System.IO.Enumeration;
using System.Text;

namespace MEditService.SourceAdapter;

/// <summary>Writes to one repository answered as the changes they make, written nowhere. Its
/// <see cref="Repository"/> reads the given unsaved texts in place of their files, and each change made through it.</summary>
public sealed class SourceBatch : ISourceFiles
{
    private enum Kind { None, File, Directory }

    private readonly IReadOnlyList<DocumentChange> _unsaved;

    private SourceBatch(SourceRepository repository, IEnumerable<DocumentChange> unsaved)
    {
        _unsaved = [.. unsaved.Select(document => document with { Path = Path.GetFullPath(document.Path) })];
        Repository = repository.Over(this);
    }

    /// <summary>A batch over <paramref name="repository"/>'s folder, reading each of <paramref name="unsaved"/>'s
    /// texts in place of the file at its absolute path.</summary>
    public static SourceBatch Over(SourceRepository repository, IReadOnlyList<DocumentChange> unsaved) => new(repository, unsaved);

    /// <summary>The repository the batch's writes are made through. Its verbs that write the disk themselves
    /// refuse.</summary>
    public SourceRepository Repository { get; }

    /// <summary>What the batch's writes change, with absolute paths. Applied as moves, then deletions, then
    /// documents, it leaves the tree as the writes would have one after another.</summary>
    public SourceChanges Changes { get; internal set; } = SourceChanges.None;

    /// <summary>What the writes since <paramref name="before"/>, a snapshot of <see cref="Changes"/>, added to it. Moves
    /// only append, so a move made since is the moves beyond those of <paramref name="before"/>.</summary>
    public SourceChanges ChangesAddedSince(SourceChanges before) =>
        new(
            [.. Changes.Moves.Skip(before.Moves.Count)],
            [.. Changes.Deletions.Except(before.Deletions, StringComparer.Ordinal)],
            [.. Changes.Documents.Except(before.Documents)]);

    /// <summary>Makes <paramref name="absolute"/>'s changes over those made so far, throwing as the file system
    /// would where one cannot be made. A move the answer's order cannot make is a defect: no gesture writes one.</summary>
    internal void Apply(SourceChanges absolute)
    {
        foreach (var (from, to) in absolute.Moves) Move(Path.GetFullPath(from), Path.GetFullPath(to));
        foreach (var path in absolute.Deletions) Delete(Path.GetFullPath(path));
        foreach (var (path, text) in absolute.Documents) Write(Path.GetFullPath(path), text);
    }

    private void Move(string from, string to)
    {
        if (KindOf(from) == Kind.None) throw new FileNotFoundException($"Could not find file '{from}'.", from);
        if (KindOf(to) != Kind.None) throw new IOException($"'{to}' already exists, so '{from}' cannot move there.");
        if (KindOf(PathShape.DirectoryOf(to)) != Kind.Directory)
            throw new DirectoryNotFoundException($"Could not find a part of the path '{to}'.");

        var fromDisk = !Deleted(from) && OnDisk(from) != Kind.None;
        if (fromDisk && (Deleted(to) || OnDisk(to) != Kind.None))
        {
            throw new InvalidOperationException(
                $"'{from}' cannot move to '{to}' in this batch: a removal in it frees that path, and the answer makes every " +
                "move before any removal.");
        }
        if (fromDisk && OnDisk(PathShape.DirectoryOf(to)) != Kind.Directory)
        {
            throw new InvalidOperationException(
                $"'{from}' cannot move to '{to}' in this batch: only a document of the batch makes that folder, and the " +
                "answer makes every move before any document.");
        }

        Changes = Changes with
        {
            Moves = fromDisk ? [.. Changes.Moves, new SourceMove(from, to)] : Changes.Moves,
            Deletions = fromDisk ? [.. Changes.Deletions.Select(deleted => Rebased(deleted, from, to))] : Changes.Deletions,
            Documents = [.. Changes.Documents.Select(document => document with { Path = Rebased(document.Path, from, to) })],
        };
    }

    private void Delete(string path)
    {
        var onDisk = !Deleted(path) && OnDisk(path) != Kind.None;
        Changes = Changes with
        {
            Deletions = onDisk ? [.. Changes.Deletions.Where(deleted => !IsUnder(path, deleted)), path] : Changes.Deletions,
            Documents = [.. Changes.Documents.Where(document => !AtOrUnder(document.Path, path))],
        };
    }

    private void Write(string path, string text)
    {
        if (KindOf(path) == Kind.Directory) throw new IOException($"'{path}' is a directory, so no document can be written there.");
        Changes = Changes with { Documents = [.. Changes.Documents.Where(document => !Same(document.Path, path)), new DocumentChange(path, text)] };
    }

    private Kind KindOf(string path) => Overlaid(path) ?? OnDisk(path);

    private Kind? Overlaid(string path)
    {
        if (Written(path) is not null) return Kind.File;
        if (Changes.Documents.Any(document => IsUnder(path, document.Path))) return Kind.Directory;
        return Deleted(path) ? Kind.None : null;
    }

    private Kind OnDisk(string path) => Unmoved(path) is { } origin ? DiskKind(origin) : Kind.None;

    private static Kind DiskKind(string path)
    {
        if (File.Exists(path)) return Kind.File;
        return Directory.Exists(path) ? Kind.Directory : Kind.None;
    }

    private string? Unmoved(string path)
    {
        for (var i = Changes.Moves.Count - 1; i >= 0; i--)
        {
            var (from, to) = Changes.Moves[i];
            if (AtOrUnder(path, to)) path = from + path[to.Length..];
            else if (AtOrUnder(path, from)) return null;
        }
        return path;
    }

    private bool Deleted(string path) => Changes.Deletions.Any(deleted => AtOrUnder(path, deleted));

    private DocumentChange? Written(string path) => Changes.Documents.FirstOrDefault(document => Same(document.Path, path));

    private static string Rebased(string path, string from, string to) => AtOrUnder(path, from) ? to + path[from.Length..] : path;

    private static bool Same(string path, string other) => string.Equals(path, other, SourceRepositoryLocator.PathComparison);

    private static bool AtOrUnder(string path, string directory) => Same(path, directory) || IsUnder(directory, path);

    private static bool IsUnder(string directory, string path) => SourceRepositoryLocator.IsUnder(directory, path);

    private List<(string Path, Kind Kind)> Children(string directory)
    {
        var full = Path.GetFullPath(directory);
        if (KindOf(full) != Kind.Directory) throw new DirectoryNotFoundException($"Could not find a part of the path '{directory}'.");

        var children = new Dictionary<string, Kind>(
            OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        if (!Deleted(full) && Unmoved(full) is { } origin && Directory.Exists(origin))
        {
            foreach (var entry in new DirectoryInfo(origin).EnumerateFileSystemInfos())
            {
                var path = Path.Combine(full, entry.Name);
                var listed = entry is DirectoryInfo ? Kind.Directory : Kind.File;
                children[entry.Name] = Overlaid(path)
                    ?? (Unmoved(path) is { } unmoved && Same(unmoved, entry.FullName) ? listed : OnDisk(path));
            }
        }
        foreach (var to in Changes.Moves.Select(move => move.To).Where(to => Same(PathShape.DirectoryOf(to), full)))
            children[Path.GetFileName(to)] = KindOf(to);
        foreach (var path in Changes.Documents.Select(document => document.Path).Where(path => IsUnder(full, path)))
        {
            var name = path[(full.Length + 1)..].Split(Path.DirectorySeparatorChar)[0];
            children[name] = KindOf(Path.Combine(full, name));
        }
        return [.. children.Where(child => child.Value != Kind.None).Select(child => (Path.Combine(directory, child.Key), child.Value))];
    }

    private IEnumerable<(string Path, Kind Kind)> Descendants(string directory) =>
        Children(directory).SelectMany(child =>
            child.Kind == Kind.Directory ? Descendants(child.Path).Prepend(child) : [child]);

    private static bool Matches(string pattern, string path) =>
        FileSystemName.MatchesSimpleExpression(pattern, Path.GetFileName(path), ignoreCase: OperatingSystem.IsWindows());

    private string? HeldText(string path, out string onDisk)
    {
        onDisk = Path.GetFullPath(path);
        if (Written(onDisk) is { } document) return document.Text;
        if (KindOf(onDisk) != Kind.File || Unmoved(onDisk) is not { } origin)
            throw new FileNotFoundException($"Could not find file '{path}'.", path);
        onDisk = origin;
        return _unsaved.FirstOrDefault(unsaved => Same(unsaved.Path, origin))?.Text;
    }

    bool ISourceFiles.FileExists(string path) => KindOf(Path.GetFullPath(path)) == Kind.File;

    bool ISourceFiles.DirectoryExists(string path) => KindOf(Path.GetFullPath(path)) == Kind.Directory;

    byte[] ISourceFiles.ReadAllBytes(string path) =>
        HeldText(path, out var onDisk) is { } text ? Encoding.UTF8.GetBytes(text) : File.ReadAllBytes(onDisk);

    bool ISourceFiles.HoldsUnsavedText(string path) => HeldText(path, out _) is not null && Written(Path.GetFullPath(path)) is null;

    string ISourceFiles.ReadAllText(string path) => HeldText(path, out var onDisk) ?? File.ReadAllText(onDisk);

    IEnumerable<string> ISourceFiles.EntriesUnder(string directory) => Descendants(directory).Select(entry => entry.Path);

    IEnumerable<string> ISourceFiles.FilesIn(string directory, string pattern, SearchOption option) =>
        (option == SearchOption.AllDirectories ? Descendants(directory) : Children(directory))
        .Where(entry => entry.Kind == Kind.File && Matches(pattern, entry.Path))
        .Select(entry => entry.Path);

    IEnumerable<string> ISourceFiles.DirectoriesIn(string directory) =>
        Children(directory).Where(entry => entry.Kind == Kind.Directory).Select(entry => entry.Path);
}
