using MEditService.Core.Plugins;

namespace MEditService.Core.Source;

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
/// lists it. ADR-0026: a partial outcome is a structured collection, never a formatted string.</summary>
internal sealed record UnrestoredPath(
    string RelativePath, string FullPath, UnrestoredReason Reason, string? Error = null);

/// <summary>A batch of puts and removes across one or more repositories, applied all or restored all
/// (ADR-0045). Conditional by design: a path something else has written since is preserved and
/// reported, never reverted.</summary>
internal sealed class SourceTransaction
{
    /// <summary>Creates or replaces one repository's document, holding its bytes so a later failure in
    /// this batch puts the file back. A record no document can hold throws before anything is
    /// recorded.</summary>
    internal void Put(SourceRepository repository, PluginKey plugin, SourceDocument document)
    {
        var identity = new RecordIdentity(document.FormKey, document.RecordType, document.EditorId);
        if (repository.Locate(plugin, identity) is not { } unit)
        {
            // Nothing to record: the repository refuses without touching the tree.
            repository.Put(plugin, document);
            return;
        }

        var before = Snapshot(unit.FullPath);
        var minted = SourceRepository.LevelsMintedBy(System.IO.Path.GetDirectoryName(unit.FullPath)!);
        try
        {
            repository.Put(plugin, document);
        }
        finally
        {
            // Ahead of the write it enabled, so the reverse pass empties the directory before taking it.
            RecordMint(repository.ModFolder, minted);
            _log.Add(new FileState(repository.ModFolder, unit.FullPath, before, Snapshot(unit.FullPath)));
        }
    }

    /// <summary>Takes one repository's record out of the tree, holding the document's bytes so the
    /// rollback puts it back. The pre-image is that one document, so a shape whose removal takes more
    /// than it is refused.</summary>
    internal SourceRemoval Remove(SourceRepository repository, PluginKey plugin, RecordIdentity identity)
    {
        if (repository.Locate(plugin, identity) is not { } unit) return SourceRemoval.NoDocumentHoldsIt;

        // Refused before the tree is touched: a container's removal takes its whole directory, block
        // subtree and all, and one document's bytes cannot put that back. A batch that cannot restore
        // an act must not perform it (ADR-0045).
        if (unit.IsDirectoryPerRecord) throw NotRestorable(unit, identity);

        var before = Snapshot(unit.FullPath);
        try
        {
            return repository.Remove(plugin, identity);
        }
        finally
        {
            _log.Add(new FileState(repository.ModFolder, unit.FullPath, before, Snapshot(unit.FullPath)));
        }
    }

    private static NotSupportedException NotRestorable(SourceUnit unit, RecordIdentity identity) =>
        new($"{identity.FormKey} has a directory of its own at {unit.RelativePath}, and removing it takes " +
            "every document under that directory. A batch holds one document's bytes per act, so it " +
            "cannot put that back — remove it outside the batch.");

    // Recorded in execution order and undone in reverse, so a rename is put back before the create that
    // provoked it.
    private abstract record Operation(string ModFolder);

    // Before/After null means no file; After is what is on disk once the act was attempted, success or
    // throw.
    private sealed record FileState(string ModFolder, string Path, byte[]? Before, byte[]? After)
        : Operation(ModFolder);

    private sealed record EntryMove(string ModFolder, string From, string To) : Operation(ModFolder);

    // Deepest first, as LevelsMintedBy names them.
    private sealed record MintedDirectories(string ModFolder, IReadOnlyList<string> Levels) : Operation(ModFolder);

    private readonly List<Operation> _log = [];

    /// <summary>Captures <paramref name="path"/>'s content before and after the write, whether it returned
    /// or threw. Minting goes through <see cref="SourceRepository.InMintedDirectory{T}"/> as any source
    /// write does.</summary>
    internal void Write(string modFolder, string path, Action write)
    {
        var directory = System.IO.Path.GetDirectoryName(path)!;
        var before = Snapshot(path);
        var minted = SourceRepository.LevelsMintedBy(directory);
        try
        {
            SourceRepository.InMintedDirectory(directory, write);
        }
        finally
        {
            // Ahead of the write it enabled, so the reverse pass empties the directory before taking it.
            RecordMint(modFolder, minted);
            _log.Add(new FileState(modFolder, path, before, Snapshot(path)));
        }
    }

    // A directory this batch minted is the batch's to take back: rolling the file away and leaving the
    // directory standing leaves an empty record directory, which fails the next ingest.
    private void RecordMint(string modFolder, IReadOnlyList<string> minted)
    {
        if (minted.Count > 0) _log.Add(new MintedDirectories(modFolder, minted));
    }

    /// <summary>Deletes <paramref name="path"/>, holding its bytes so the rollback can put the file
    /// back. The same <see cref="FileState"/> shape a write records — a delete is just the one whose
    /// after-state is "absent".</summary>
    internal void Delete(string modFolder, string path)
    {
        var before = Snapshot(path);
        try
        {
            File.Delete(path);
        }
        finally
        {
            _log.Add(new FileState(modFolder, path, before, Snapshot(path)));
        }
    }

    /// <summary>Recorded only once the move has happened: <c>Directory.Move</c>/<c>File.Move</c> either
    /// rename the entry or leave it, so a throw leaves nothing to undo.</summary>
    internal void Move(string modFolder, string from, string to)
    {
        SourceRepository.MoveEntry(from, to);
        _log.Add(new EntryMove(modFolder, from, to));
    }

    /// <summary>Puts every recorded act back, most recent first, so a name this action took is vacated
    /// before an earlier act moves back into it. A restore failure never stops the pass; it is
    /// collected (ADR-0026), not thrown.</summary>
    internal IReadOnlyList<UnrestoredPath> Rollback()
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
                    SourceRepository.RemoveMintedLevels(mint.Levels);
                    break;
            }
        }

        return unrestored;
    }

    private static void RestoreFile(FileState file, List<UnrestoredPath> unrestored)
    {
        // "Absent" and "unreadable" must not collapse into one null: a pre-image that read as absent because
        // the read failed would have the rollback delete a file it never created.
        if (ReferenceEquals(file.Before, Unreadable) || ReferenceEquals(file.After, Unreadable))
        {
            unrestored.Add(Named(file.ModFolder, file.Path, UnrestoredReason.RestoreFailed,
                "its content could not be read while the renumber wrote it, so there is nothing to compare against"));
            return;
        }

        // The act changed nothing (a write that threw before its rename): naming an unaltered path would
        // send the author looking for damage that is not there.
        if (SameBytes(file.Before, file.After)) return;

        var current = Snapshot(file.Path);
        if (ReferenceEquals(current, Unreadable))
        {
            // By reference: Unreadable is a zero-length array and would compare equal to a legitimately empty file.
            unrestored.Add(Named(file.ModFolder, file.Path, UnrestoredReason.RestoreFailed,
                "it could not be read, so there is no way to tell whether it still holds what this renumber wrote"));
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
            unrestored.Add(Named(file.ModFolder, file.Path, UnrestoredReason.RestoreFailed, ex.Message));
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
            SourceRepository.MoveEntry(move.To, move.From);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add(Named(move.ModFolder, move.From, UnrestoredReason.RestoreFailed, ex.Message));
        }
    }

    private static UnrestoredPath Named(string modFolder, string path, UnrestoredReason reason, string? error = null) =>
        new(System.IO.Path.GetRelativePath(modFolder, path), path, reason, error);

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
