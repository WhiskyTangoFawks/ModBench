using System.Text;
using MEditService.Codec.Serialization;

namespace MEditService.SourceAdapter;

/// <summary>Why a rollback left a path as it stood. Every value is a preserved outcome except
/// <see cref="RestoreFailed"/>, the one that reports damage rather than deference.</summary>
internal enum UnrestoredReason
{
    /// <summary>Something else has written the file since this action did; its bytes are left alone.</summary>
    ChangedByAnother,

    /// <summary>The file this action wrote is gone. Not resurrected: whatever removed it meant to.</summary>
    RemovedByAnother,

    /// <summary>A file this action removed was written again; its bytes are left alone.</summary>
    WrittenByAnother,

    /// <summary>A move cannot be undone because its origin is occupied again — putting the entry back
    /// would overwrite whatever now stands there.</summary>
    OccupiedByAnother,

    /// <summary>A directory this action made now holds something else's.</summary>
    HoldsSomethingElse,

    /// <summary>The restore was attempted and the filesystem refused it. The only value here that
    /// reports damage rather than deference.</summary>
    RestoreFailed,
}

/// <summary>One thing a rollback left standing (ADR-0019): a path relative to the mod folder, or a
/// description of a change outside the file tree. Detail is the operating system's reason for a refusal.</summary>
internal sealed record Unrestored(
    UnrestoredReason Reason, string? RelativePath = null, string? Description = null, string? Detail = null);

/// <summary>Everything a Source adapter act creates, replaces, moves and mints under one mod folder. One
/// rollback restores exactly that, leaves what another program wrote (ADR-0003) and answers what it
/// could not restore as data (ADR-0019).</summary>
internal sealed class WriteJournal(string modFolder)
{
    private interface IEntry;

    private sealed record MintedDirectory(string Path) : IEntry;

    private sealed record RemovedDirectory(string Path) : IEntry;

    private sealed record FileState(string Path, byte[]? Before, byte[]? After) : IEntry;

    private sealed record DeletedFile(string Path, byte[] Original) : IEntry;

    private sealed record DeletedTree(List<string> Directories, List<(string Path, byte[] Bytes)> Files) : IEntry;

    private sealed record EntryMove(string From, string To) : IEntry;

    private sealed record TempFile(string Path) : IEntry;

    private sealed record PutBack(Action Undo, string? Path, string? Description) : IEntry;

    // Distinct from absent (null) and any real content; compared by reference, never by value.
    private static readonly byte[] Unreadable = [];

    private readonly List<IEntry> _entries = [];

    internal int Mark => _entries.Count;

    internal void CreateDirectory(string directory)
    {
        var missing = new Stack<string>();
        for (var ancestor = directory; !string.IsNullOrEmpty(ancestor) && !Directory.Exists(ancestor); ancestor = PathShape.DirectoryOf(ancestor))
            missing.Push(ancestor);
        foreach (var minted in missing) _entries.Add(new MintedDirectory(minted));
        Directory.CreateDirectory(directory);
    }

    internal void Write(string path, byte[] content)
    {
        CreateDirectory(PathShape.DirectoryOf(path));
        var before = Snapshot(path);
        var temp = TempPathFor(path);
        _entries.Add(new TempFile(temp));
        try
        {
            WriteAtomic(path, content, temp);
            _entries.Add(new FileState(path, before, content));
        }
        catch
        {
            var after = Snapshot(path);
            if (ReferenceEquals(after, Unreadable) || !SameBytes(before, after)) _entries.Add(new FileState(path, before, after));
            throw;
        }
    }

    internal void WriteAll(IEnumerable<TreeFile> files, string baseDirectory)
    {
        foreach (var file in files) Write(Path.Combine(baseDirectory, file.RelativePath), file.Content);
    }

    internal void WriteText(string path, string text) => Write(path, Encoding.UTF8.GetBytes(text));

    internal void Delete(string path)
    {
        var original = Snapshot(path);
        if (original == null) return;
        _entries.Add(new DeletedFile(path, original));
        File.Delete(path);
    }

    internal void DeleteIfHolds(string path, byte[] expected)
    {
        if (!SameBytes(Snapshot(path), expected)) throw new IOException($"{path} was changed by another program, so it was not removed.");
        Delete(path);
    }

    internal void DeleteEmptyDirectories(string directory)
    {
        if (!Directory.Exists(directory)) return;
        foreach (var child in Directory.GetDirectories(directory)) DeleteEmptyDirectories(child);
        if (Directory.EnumerateFileSystemEntries(directory).Any()) return;
        _entries.Add(new RemovedDirectory(directory));
        Directory.Delete(directory);
    }

    // A failed recursive delete goes on past the entry it could not take, so it stops partway. What went
    // is put back; a file still standing is left alone, as this delete never wrote it.
    internal void DeleteTree(string directory)
    {
        _entries.Add(new DeletedTree(
            [.. Directory.GetDirectories(directory, "*", SearchOption.AllDirectories).Prepend(directory).Order(StringComparer.Ordinal)],
            [.. Directory.GetFiles(directory, "*", SearchOption.AllDirectories)
                .Order(StringComparer.Ordinal)
                .Select(path => (Path: path, Bytes: File.ReadAllBytes(path)))]));
        Directory.Delete(directory, recursive: true);
    }

    internal void Move(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
        _entries.Add(new EntryMove(from, to));
    }

    /// <summary>Records a change that <paramref name="undo"/> puts back, such as a git ref or a repository
    /// directory; the rollback names <paramref name="path"/> or <paramref name="description"/> when it cannot.</summary>
    internal void RecordUndo(Action undo, string? path = null, string? description = null) =>
        _entries.Add(new PutBack(undo, path, description));

    internal List<Unrestored> UndoSince(int mark)
    {
        var unrestored = new List<Unrestored>();
        for (var i = _entries.Count - 1; i >= mark; i--) Undo(_entries[i], i, unrestored);
        _entries.RemoveRange(mark, _entries.Count - mark);
        return unrestored;
    }

    /// <summary>None when the rollback left nothing. Otherwise the cause's own stop, or an IOException when
    /// the cause is another failed write, naming what it left; else an AggregateException so no refusal
    /// handler catches a defect.</summary>
    internal Exception? Report(Exception cause, List<Unrestored> unrestored)
    {
        if (unrestored.Count == 0) return null;
        var message = Describe(cause.Message, unrestored);
        if (cause is SourceStopException stop) return SourceStopException.Of(stop.Failure.Saying(message), stop);
        return IsAFailedWrite(cause) ? new IOException(message, cause) : new AggregateException(message, cause);
    }

    internal string Describe(string message, List<Unrestored> unrestored)
    {
        if (unrestored.Count == 0) return message;
        var sentences = unrestored.Select(Sentence);
        return $"{message} Not put back: {string.Join(" ", sentences)}".Replace(
            modFolder + Path.DirectorySeparatorChar, "", StringComparison.Ordinal);
    }

    private static string Sentence(Unrestored left)
    {
        var phrase = left.Reason switch
        {
            UnrestoredReason.ChangedByAnother => "changed by something else after this change wrote it, so its current content was kept",
            UnrestoredReason.RemovedByAnother => "removed by something else after this change wrote it, so it was not put back",
            UnrestoredReason.WrittenByAnother => "written by something else after this change removed it, so its current content was kept",
            UnrestoredReason.OccupiedByAnother => "occupied by something else, so what this change moved away was not moved back",
            UnrestoredReason.HoldsSomethingElse => "holds something this change did not write, so it was left",
            _ => "could not be restored",
        };
        return $"{left.RelativePath ?? left.Description} — {phrase}{(left.Detail is null ? "" : $": {left.Detail}")}.";
    }

    internal static bool IsAFailedWrite(Exception cause) =>
        cause is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception;

    private void Undo(IEntry entry, int index, List<Unrestored> unrestored)
    {
        switch (entry)
        {
            case MintedDirectory minted:
                UndoMint(minted, index, unrestored);
                break;
            case RemovedDirectory removed:
                Attempt(removed.Path, () => Directory.CreateDirectory(removed.Path), unrestored);
                break;
            case FileState file:
                RestoreFile(file, unrestored);
                break;
            case DeletedFile deleted:
                RestoreDeleted(deleted, unrestored);
                break;
            case DeletedTree tree:
                foreach (var level in tree.Directories) Attempt(level, () => Directory.CreateDirectory(level), unrestored);
                foreach (var (path, bytes) in tree.Files.Where(file => !File.Exists(file.Path)))
                    Attempt(path, () => File.WriteAllBytes(path, bytes), unrestored);
                break;
            case EntryMove move:
                RestoreMove(move, unrestored);
                break;
            case TempFile temp:
                Attempt(temp.Path, () => { if (File.Exists(temp.Path)) File.Delete(temp.Path); }, unrestored);
                break;
            case PutBack putBack:
                try
                {
                    putBack.Undo();
                }
                catch (Exception ex) when (IsAFailedWrite(ex))
                {
                    unrestored.Add(new Unrestored(
                        UnrestoredReason.RestoreFailed,
                        putBack.Path is null ? null : Path.GetRelativePath(modFolder, putBack.Path),
                        putBack.Description,
                        ex.Message));
                }

                break;
        }
    }

    private void UndoMint(MintedDirectory minted, int index, List<Unrestored> unrestored)
    {
        if (!Directory.Exists(minted.Path)) return;
        try
        {
            if (!Directory.EnumerateFileSystemEntries(minted.Path).Any()) Directory.Delete(minted.Path);
            else if (!_entries.Take(index).Any(earlier => earlier is RemovedDirectory removed && removed.Path == minted.Path))
                unrestored.Add(Named(minted.Path, UnrestoredReason.HoldsSomethingElse));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add(Named(minted.Path, UnrestoredReason.RestoreFailed, ex.Message));
        }
    }

    private void RestoreFile(FileState file, List<Unrestored> unrestored)
    {
        // "Absent" and "unreadable" must not collapse into one null: a pre-image that read as absent because
        // the read failed would have the rollback delete a file it never created.
        if (ReferenceEquals(file.Before, Unreadable) || ReferenceEquals(file.After, Unreadable))
        {
            unrestored.Add(Named(file.Path, UnrestoredReason.RestoreFailed));
            return;
        }

        var current = Snapshot(file.Path);
        if (ReferenceEquals(current, Unreadable))
        {
            unrestored.Add(Named(file.Path, UnrestoredReason.RestoreFailed));
            return;
        }

        if (!SameBytes(current, file.After))
        {
            unrestored.Add(Named(file.Path, current == null ? UnrestoredReason.RemovedByAnother : UnrestoredReason.ChangedByAnother));
            return;
        }

        Attempt(file.Path, () =>
        {
            if (file.Before == null) File.Delete(file.Path);
            else WriteAtomic(file.Path, file.Before);
        }, unrestored);
    }

    private void RestoreDeleted(DeletedFile deleted, List<Unrestored> unrestored)
    {
        var current = Snapshot(deleted.Path);
        if (ReferenceEquals(current, Unreadable)) unrestored.Add(Named(deleted.Path, UnrestoredReason.RestoreFailed));
        else if (current == null && ReferenceEquals(deleted.Original, Unreadable))
            unrestored.Add(Named(deleted.Path, UnrestoredReason.RestoreFailed, "its content could not be read before it was removed"));
        else if (current == null) Attempt(deleted.Path, () => WriteAtomic(deleted.Path, deleted.Original), unrestored);
        else if (!SameBytes(current, deleted.Original)) unrestored.Add(Named(deleted.Path, UnrestoredReason.WrittenByAnother));
    }

    private void RestoreMove(EntryMove move, List<Unrestored> unrestored)
    {
        if (!Exists(move.To))
        {
            unrestored.Add(Named(move.To, UnrestoredReason.RemovedByAnother));
            return;
        }

        if (Exists(move.From))
        {
            unrestored.Add(Named(move.From, UnrestoredReason.OccupiedByAnother));
            return;
        }

        Attempt(move.From, () =>
        {
            if (Directory.Exists(move.To)) Directory.Move(move.To, move.From);
            else File.Move(move.To, move.From);
        }, unrestored);
    }

    private void Attempt(string path, Action restore, List<Unrestored> unrestored)
    {
        try
        {
            restore();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add(Named(path, UnrestoredReason.RestoreFailed, ex.Message));
        }
    }

    private Unrestored Named(string path, UnrestoredReason reason, string? detail = null) =>
        new(reason, Path.GetRelativePath(modFolder, path), Detail: detail);

    private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    private static string TempPathFor(string path) =>
        Path.Combine(PathShape.DirectoryOf(path), ".medit_tmp_" + Path.GetRandomFileName() + ".tmp");

    private static void WriteAtomic(string path, byte[] content, string? tempPath = null)
    {
        tempPath ??= TempPathFor(path);
        try
        {
            File.WriteAllBytes(tempPath, content);
            File.Move(tempPath, path, overwrite: true);
        }
        catch
        {
            File.Delete(tempPath);
            throw;
        }
    }

    // A directory standing where a file is expected reads as null; the comparison keeps the rollback from
    // writing over it.
    private static byte[]? Snapshot(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllBytes(path) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Unreadable;
        }
    }

    private static bool SameBytes(byte[]? left, byte[]? right) =>
        left == null ? right == null : right != null && left.AsSpan().SequenceEqual(right);
}
