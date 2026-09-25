using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>Why a rollback left a path as it stood. Every value is a preserved outcome except
/// <see cref="RestoreFailed"/>, the one that reports damage rather than deference.</summary>
public enum UnrestoredReason
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
/// lists it. ADR-0019: a partial outcome is a structured collection, never a formatted string.</summary>
public sealed record UnrestoredPath(
    string RelativePath, string FullPath, UnrestoredReason Reason, string? Error = null);

/// <summary>Rollback's own filesystem primitives (ADR-0007): nested so undoing a mint or a move reaches
/// the same private machinery the put or move it undoes used, rather than a second copy of it.</summary>
public sealed partial class SourceRepository
{
    /// <summary>A batch of puts, removes and moves, each by identity, across one or more repositories,
    /// applied all or restored all (ADR-0007). Conditional by design: a path something else has written
    /// since is preserved and reported, never reverted.</summary>
    public sealed class SourceTransaction
    {
        /// <summary>Creates or replaces one repository's document, holding its bytes so a later failure in
        /// this batch puts the file back. A record no document can hold throws before anything is
        /// recorded.</summary>
        public void Put(SourceRepository repository, PluginCopyKey plugin, SourceDocument document)
        {
            var identity = new RecordIdentity(document.FormKey, document.RecordType, document.EditorId);

            // Refused before the tree is touched, as a container's removal is: putting a record no
            // document holds would have the repository decide its place and mint the levels above it,
            // which one document's bytes cannot take back.
            if (repository.Locate(plugin, identity) is not { } unit) throw NotRestorableCreate(plugin, identity);

            var before = Snapshot(unit.FullPath);
            var minted = LevelsMintedBy(PathShape.DirectoryOf(unit.FullPath));
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
        public SourceRemoval Remove(SourceRepository repository, PluginCopyKey plugin, RecordIdentity identity)
        {
            if (repository.Locate(plugin, identity) is not { } unit) return SourceRemoval.NoDocumentHoldsIt;

            // Refused before the tree is touched: a container's removal takes its whole directory, block
            // subtree and all, and one document's bytes cannot put that back. A batch that cannot restore
            // an act must not perform it (ADR-0007).
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

        private static NotSupportedException NotRestorableCreate(PluginCopyKey plugin, RecordIdentity identity) =>
            new($"No document in {plugin.Name}'s tree holds {identity.FormKey} and its type has no file of its " +
                "own, so putting it would create one and mint the levels above it. A batch holds one " +
                "document's bytes per act, so it cannot put that back — put it outside the batch.");

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

        private sealed record MintedDirectories(string ModFolder, List<string> Levels) : Operation(ModFolder);

        private readonly List<Operation> _log = [];

        // A directory this batch minted is the batch's to take back: rolling the file away and leaving the
        // directory standing leaves an empty record directory, which fails the next ingest.
        private void RecordMint(string modFolder, List<string> minted)
        {
            if (minted.Count > 0) _log.Add(new MintedDirectories(modFolder, minted));
        }

        /// <summary>Moves a container to <paramref name="newFormKey"/>'s leaf and records what moved. A
        /// no-op — nothing found, not a container, or already at that leaf — logs nothing.</summary>
        public void Move(SourceRepository repository, PluginCopyKey plugin, RecordIdentity identity, string newFormKey)
        {
            if (repository.Move(plugin, identity, newFormKey) is not { } moved) return;
            _log.Add(new EntryMove(repository.ModFolder, moved.From, moved.To));
        }

        /// <summary>Puts every recorded act back, most recent first, so a name this action took is vacated
        /// before an earlier act moves back into it. A restore failure never stops the pass; it is
        /// collected (ADR-0019), not thrown.</summary>
        public IReadOnlyList<UnrestoredPath> Rollback()
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
                        RemoveMintedLevels(mint.Levels);
                        break;
                }
            }

            return unrestored;
        }

        /// <summary>Rolls back, then answers <paramref name="cause"/>'s own message with every mod folder
        /// this batch touched, and <paramref name="repository"/>'s, stripped out of it, so a report reads
        /// the same whichever tree the fault named.</summary>
        public (IReadOnlyList<UnrestoredPath> Unrestored, string RelativeError) Rollback(
            Exception cause, SourceRepository repository)
        {
            var unrestored = Rollback();
            var modFolders = _log.Select(op => op.ModFolder).Append(repository.ModFolder).Distinct().ToList();
            var relativeError = modFolders
                .OrderByDescending(f => f.Length)
                .Aggregate(cause.Message, (text, folder) => text.Replace(folder + Path.DirectorySeparatorChar, "", StringComparison.Ordinal));
            return (unrestored, relativeError);
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
                MoveEntry(move.To, move.From);
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
}
