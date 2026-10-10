using System.IO.Enumeration;
using System.Text;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <inheritdoc/>
internal sealed class WriteSession : IWriteSession, ISourceFiles
{
    private enum Kind { None, File, Directory }

    private readonly UnsavedFiles _unsaved;
    private readonly SourceRepository _repository;
    private bool _writing;
    private SourceFailure? _stopped;

    private WriteSession(PluginProvider.FromMod mod, GameRelease release, IEnumerable<DocumentChange> held)
    {
        _unsaved = new UnsavedFiles(held);
        _repository = SourceRepository.Over(mod, release).Over(this);
    }

    /// <summary>A session over <paramref name="mod"/>'s folder, reading each of <paramref name="held"/>'s texts in
    /// place of the file at its absolute path.</summary>
    public static WriteSession Over(PluginProvider.FromMod mod, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        new(mod, release, held);

    public ISourceRepository Repository => _repository;

    public SourceChanges Changes { get; private set; } = SourceChanges.None;

    public SourceChanges ChangesAddedSince(SourceChanges before) =>
        new(
            [.. Changes.Moves.Skip(before.Moves.Count)],
            [.. Changes.Deletions.Except(before.Deletions, StringComparer.Ordinal)],
            [.. Changes.Documents.Except(before.Documents)]);

    public SourceFailure? Atomically(Action write) =>
        Atomically(() =>
        {
            write();
            return SourceAnswer.Of(true);
        }).Holds(out _, out var failure)
            ? null
            : failure;

    public Answer<T, SourceFailure> Atomically<T>(Func<Answer<T, SourceFailure>> write)
    {
        if (_writing) throw new InvalidOperationException("Atomically does not nest: the changes inside it already apply all or none.");
        var before = Changes;
        (_stopped, _writing) = (null, true);
        try
        {
            var answered = SourceFailure.Answer(write).Then(made => made);
            if (!answered.Holds(out _, out var failure)) _stopped ??= failure;
            if (_stopped is not { } stopped) return answered;
            PutBack(before);
            return stopped;
        }
        catch
        {
            PutBack(before);
            throw;
        }
        finally
        {
            _writing = false;
        }
    }

    private void PutBack(SourceChanges before)
    {
        Changes = before;
        _repository.Locator.Forget();
    }

    /// <summary>Makes each move of <paramref name="changes"/>, then each deletion, then writes each document, over those
    /// made so far. Changes that failed stop the write applying them, and nothing after them applies.</summary>
    public void Apply(Answer<SourceChanges, SourceFailure> changes)
    {
        if (!_writing) throw new InvalidOperationException("Changes are applied inside Atomically, which answers whether they all applied.");
        if (_stopped is not null) return;
        if (!changes.Holds(out var made, out var failure))
        {
            _stopped = failure;
            return;
        }

        try
        {
            Apply(made.Under(_repository.ModFolder));
        }
        catch (Exception ex) when (SourceFailure.Of(ex) is { } stopped)
        {
            _stopped = stopped;
        }
        finally
        {
            _repository.Locator.Forget();
        }
    }

    // Throws as the file system would where a change cannot be made. A move the answer's order cannot make is a
    // defect: no gesture writes one.
    private void Apply(SourceChanges absolute)
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
                $"'{from}' cannot move to '{to}' in this session: a removal in it frees that path, and the answer makes every " +
                "move before any removal.");
        }
        if (fromDisk && OnDisk(PathShape.DirectoryOf(to)) != Kind.Directory)
        {
            throw new InvalidOperationException(
                $"'{from}' cannot move to '{to}' in this session: only a document of the session makes that folder, and the " +
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

    private Kind DiskKind(string path)
    {
        if (_unsaved.FileExists(path)) return Kind.File;
        return _unsaved.DirectoryExists(path) ? Kind.Directory : Kind.None;
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
        if (!Deleted(full) && Unmoved(full) is { } origin && _unsaved.DirectoryExists(origin))
        {
            var listing = _unsaved.DirectoriesIn(origin).Select(entry => (Entry: entry, Kind: Kind.Directory))
                .Concat(_unsaved.FilesIn(origin, "*", SearchOption.TopDirectoryOnly).Select(entry => (Entry: entry, Kind: Kind.File)));
            foreach (var (entry, listed) in listing)
            {
                var name = Path.GetFileName(entry);
                var path = Path.Combine(full, name);
                children[name] = Overlaid(path)
                    ?? (Unmoved(path) is { } unmoved && Same(unmoved, entry) ? listed : OnDisk(path));
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

    private (string? Written, string Origin) Held(string path)
    {
        var full = Path.GetFullPath(path);
        if (Written(full) is { } document) return (document.Text, full);
        if (KindOf(full) != Kind.File || Unmoved(full) is not { } origin)
            throw new FileNotFoundException($"Could not find file '{path}'.", path);
        return (null, origin);
    }

    bool ISourceFiles.FileExists(string path) => KindOf(Path.GetFullPath(path)) == Kind.File;

    bool ISourceFiles.DirectoryExists(string path) => KindOf(Path.GetFullPath(path)) == Kind.Directory;

    byte[] ISourceFiles.ReadAllBytes(string path) =>
        Held(path) is var (written, origin) && written is not null ? Encoding.UTF8.GetBytes(written) : _unsaved.ReadAllBytes(origin);

    bool ISourceFiles.HoldsUnsavedText(string path) => Held(path) is (null, var origin) && _unsaved.HoldsUnsavedText(origin);

    string ISourceFiles.ReadAllText(string path) =>
        Held(path) is var (written, origin) && written is not null ? written : _unsaved.ReadAllText(origin);

    IEnumerable<string> ISourceFiles.EntriesUnder(string directory) => Descendants(directory).Select(entry => entry.Path);

    IEnumerable<string> ISourceFiles.FilesIn(string directory, string pattern, SearchOption option) =>
        (option == SearchOption.AllDirectories ? Descendants(directory) : Children(directory))
        .Where(entry => entry.Kind == Kind.File && Matches(pattern, entry.Path))
        .Select(entry => entry.Path);

    IEnumerable<string> ISourceFiles.DirectoriesIn(string directory) =>
        Children(directory).Where(entry => entry.Kind == Kind.Directory).Select(entry => entry.Path);
}
