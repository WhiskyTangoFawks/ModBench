
namespace MEditService.SourceAdapter;

/// <summary>Why a rollback left a path as it stood. Every value is a preserved outcome except
/// <see cref="RestoreFailed"/>, the one that reports damage rather than deference.</summary>
internal enum UnrestoredReason
{
    /// <summary>Something else has written the file since this action did; its bytes are left alone.</summary>
    ChangedByAnother,

    /// <summary>The file this action wrote is gone. Not resurrected: whatever removed it meant to.</summary>
    RemovedByAnother,

    /// <summary>A move cannot be undone because its origin is occupied again — putting the entry back
    /// would overwrite whatever now stands there.</summary>
    OccupiedByAnother,

    /// <summary>The restore was attempted and the filesystem refused it. The only value here that
    /// reports damage rather than deference.</summary>
    RestoreFailed,
}

/// <summary>One path a rollback left standing, relative to the mod folder as the Source Control panel
/// lists it (ADR-0019).</summary>
internal sealed record UnrestoredPath(string RelativePath, UnrestoredReason Reason);

/// <summary>Source changes to one repository, applied all or restored all (commands.md,
/// A failed gesture writes nothing; ADR-0003).</summary>
public sealed class SourceTransaction
{
    private readonly SourceRepository _repository;

    private SourceTransaction(SourceRepository repository) => _repository = repository;

    /// <summary>Runs <paramref name="write"/> on a new transaction. A throw puts back what it applied and is
    /// rethrown, or becomes the rollback's report when that left a path standing.</summary>
    public static void Atomically(SourceRepository repository, Action<SourceTransaction> write)
    {
        var transaction = new SourceTransaction(repository);
        try
        {
            write(transaction);
        }
        catch (Exception cause) when (cause is not OutOfMemoryException)
        {
            var (unrestored, report) = transaction.Rollback(cause);
            if (unrestored.Count == 0) throw;
            throw new IOException(report, cause);
        }
    }

    /// <summary>Makes each move of <paramref name="changes"/> and then writes each document, holding what
    /// each act replaced so a later failure in this batch puts it back.</summary>
    public void Apply(SourceChanges changes)
    {
        var (moves, documents) = changes.Under(_repository);
        try
        {
            foreach (var (from, to) in moves)
            {
                SourceRepositoryLayout.MoveEntry(from, to);
                _log.Add(new EntryMove(_repository.ModFolder, from, to));
            }

            foreach (var (path, text) in documents) Write(_repository.ModFolder, path, text);
        }
        finally
        {
            _repository.Locator.Forget();
        }
    }

    private void Write(string modFolder, string path, string text)
    {
        var before = Snapshot(path);
        var directory = PathShape.DirectoryOf(path);
        var minted = SourceRepositoryLayout.LevelsMintedBy(directory);
        try
        {
            SourceRepositoryLayout.InMintedDirectory(directory, () => SourceRepositoryLayout.WriteTextAtomic(path, text));
        }
        finally
        {
            // Ahead of the write it enabled, so the reverse pass empties the directory before taking it.
            RecordMint(modFolder, minted);
            _log.Add(new FileState(modFolder, path, before, Snapshot(path)));
        }
    }

    // Recorded in execution order and undone in reverse, so a rename is put back before the create that
    // provoked it.
    private abstract record Operation(string ModFolder);

    // Before/After null means no file; After is what is on disk once the act was attempted, success or
    // throw.
    private sealed record FileState(string ModFolder, string Path, byte[]? Before, byte[]? After)
        : Operation(ModFolder);

    private sealed record EntryMove(string ModFolder, string From, string To) : Operation(ModFolder);

    private sealed record MintedDirectories(string ModFolder, List<string> Levels) : Operation(ModFolder);

    private readonly List<Operation> _log = [];

    // A directory this batch minted is the batch's to take back: rolling the file away and leaving the
    // directory standing leaves an empty record directory, which fails the next ingest.
    private void RecordMint(string modFolder, List<string> minted)
    {
        if (minted.Count > 0) _log.Add(new MintedDirectories(modFolder, minted));
    }

    // A restore failure is collected, never thrown (ADR-0019).
    private List<UnrestoredPath> UndoLog()
    {
        var unrestored = new List<UnrestoredPath>();
        for (var i = _log.Count - 1; i >= 0; i--)
        {
            switch (_log[i])
            {
                case FileState file:
                    RestoreFile(file, unrestored);
                    break;
                case EntryMove move:
                    RestoreMove(move, unrestored);
                    break;
                case MintedDirectories mint:
                    SourceRepositoryLayout.RemoveMintedLevels(mint.Levels);
                    break;
            }
        }

        return unrestored;
    }

    private (List<UnrestoredPath> Unrestored, string Report) Rollback(Exception cause)
    {
        var unrestored = UndoLog();
        var modFolders = _log.Select(op => op.ModFolder).Append(_repository.ModFolder).Distinct().ToList();
        var relativeError = modFolders
            .OrderByDescending(f => f.Length)
            .Aggregate(cause.Message, (text, folder) => text.Replace(folder + Path.DirectorySeparatorChar, "", StringComparison.Ordinal));
        return (unrestored, Report(unrestored, relativeError));
    }

    private static string Report(List<UnrestoredPath> unrestored, string relativeError)
    {
        var sentences = new List<string>
        {
            unrestored.Count == 0
                ? "Every source tree it had written is back as it was — nothing to review or revert."
                : "Every source tree it had written is back as it was, except:",
        };

        sentences.AddRange(new[]
        {
            (UnrestoredReason.ChangedByAnother,
                "changed by something else after this change wrote them, so their current content was kept"),
            (UnrestoredReason.RemovedByAnother,
                "removed by something else after this change wrote them, so they were not put back"),
            (UnrestoredReason.OccupiedByAnother,
                "occupied by something else, so what this change moved away was not moved back"),
            (UnrestoredReason.RestoreFailed, "could not be restored"),
        }.Select(r => NamedPaths(unrestored, r.Item1, r.Item2)).OfType<string>());

        sentences.Add($"Underlying error: {relativeError}");
        return string.Join(" ", sentences);
    }

    private static string? NamedPaths(List<UnrestoredPath> unrestored, UnrestoredReason reason, string phrase)
    {
        var named = unrestored.Where(u => u.Reason == reason).Select(u => u.RelativePath).ToList();
        return named.Count == 0 ? null : $"{string.Join(", ", named)} — {phrase}.";
    }

    private static void RestoreFile(FileState file, List<UnrestoredPath> unrestored)
    {
        // "Absent" and "unreadable" must not collapse into one null: a pre-image that read as absent because
        // the read failed would have the rollback delete a file it never created.
        if (ReferenceEquals(file.Before, Unreadable) || ReferenceEquals(file.After, Unreadable))
        {
            unrestored.Add(Named(file.ModFolder, file.Path, UnrestoredReason.RestoreFailed));
            return;
        }

        // The act changed nothing (a write that threw before its rename): naming an unaltered path would
        // send the author looking for damage that is not there.
        if (SameBytes(file.Before, file.After)) return;

        var current = Snapshot(file.Path);
        if (ReferenceEquals(current, Unreadable))
        {
            // By reference: Unreadable is a zero-length array and would compare equal to a legitimately empty file.
            unrestored.Add(Named(file.ModFolder, file.Path, UnrestoredReason.RestoreFailed));
            return;
        }

        if (!SameBytes(current, file.After))
        {
            unrestored.Add(Named(file.ModFolder, file.Path,
                current == null ? UnrestoredReason.RemovedByAnother : UnrestoredReason.ChangedByAnother));
            return;
        }

        try
        {
            if (file.Before == null) File.Delete(file.Path);
            else File.WriteAllBytes(file.Path, file.Before);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add(Named(file.ModFolder, file.Path, UnrestoredReason.RestoreFailed));
        }
    }

    private static void RestoreMove(EntryMove move, List<UnrestoredPath> unrestored)
    {
        if (!Exists(move.To))
        {
            unrestored.Add(Named(move.ModFolder, move.To, UnrestoredReason.RemovedByAnother));
            return;
        }

        if (Exists(move.From))
        {
            unrestored.Add(Named(move.ModFolder, move.From, UnrestoredReason.OccupiedByAnother));
            return;
        }

        try
        {
            SourceRepositoryLayout.MoveEntry(move.To, move.From);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add(Named(move.ModFolder, move.From, UnrestoredReason.RestoreFailed));
        }
    }

    private static UnrestoredPath Named(string modFolder, string path, UnrestoredReason reason) =>
        new(System.IO.Path.GetRelativePath(modFolder, path), reason);

    private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    // Distinct from absent (null) and any real content; compared by reference, never by value.
    private static readonly byte[] Unreadable = [];

    // A directory standing where a file is expected reads as null; the pre-image comparison keeps the
    // rollback from writing over it.
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
