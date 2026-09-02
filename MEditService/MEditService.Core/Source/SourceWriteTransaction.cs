namespace MEditService.Core.Source;

/// <summary>Why one path came out of a rollback still holding something other than its pre-action
/// content. Every value is a *preserved* outcome except <see cref="RestoreFailed"/>: the first three
/// say the rollback deliberately did not touch the path, the last says it tried and could not.</summary>
internal enum UnrestoredReason
{
    /// <summary>The file no longer holds what this action wrote it — something else has written it
    /// since. Its bytes are that writer's, and are left alone.</summary>
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

/// <summary>One path a rollback left standing, named the way the author sees it (relative to the mod
/// folder, which is what the Source Control panel lists) with the absolute path alongside for the
/// log. ADR-0026: a partial outcome is a structured collection, never a formatted string.</summary>
internal sealed record UnrestoredPath(
    string RelativePath, string FullPath, UnrestoredReason Reason, string? Error = null);

/// <summary>
/// The pre-images of the source files one action is about to write, held for the duration of that
/// action so a failure part-way can put the working trees back (ADR-0045). Built and driven by
/// <see cref="Edits.RecordEditService.RenumberRecord"/> alone — not an ambient scope, not a chokepoint
/// every write passes through: a caller that wants failure atomicity constructs one and routes its own
/// writes through it, and every other write path is unchanged.
///
/// <para><b>No git.</b> Nothing is written into the author's repository and no git command is run;
/// commit, stash and discard stay the author's gestures (ADR-0041). The pre-images live in memory for
/// the length of one call and are dropped with it, which is also why process death is out of scope —
/// the compile round-trip gate and re-Track remain its recovery path.</para>
///
/// <para><b>The guarantee is conditional, deliberately.</b> Before restoring a path this verifies the
/// path still holds exactly what the action left there. If another tool or the author has written or
/// deleted it since (root <c>CLAUDE.md</c>: never assume exclusive ownership of a file on disk), that
/// change is preserved and named in <see cref="Rollback"/>'s report rather than reverted. So: a failed
/// action restores the working tree byte-for-byte with respect to everything it changed, and nothing
/// else.</para>
///
/// <para><b>Directory <i>minting</i> is <see cref="SourceUnitResolver.InMintedDirectory{T}"/>'s
/// business, not this class's.</b> A write routed through <see cref="Write"/> goes through that
/// wrapper, so a write that dies having minted ancestors takes exactly those back out again
/// (#675). This holds no directory pre-images of its own and must not grow any, or the two mechanisms
/// would race to remove the same level. The one directory shape this <i>does</i> own is
/// <see cref="Move"/>: a relocated subtree is put back where it stood.
///
/// <para><b>The seam between them, stated exactly so nobody has to rediscover it.</b> #675 removes a
/// minted directory when <i>that</i> write throws. It does not, and cannot, remove one minted by a
/// write that <i>succeeded</i> and is only being undone now because a later act failed — so a
/// rollback that deletes a file this action created leaves behind whatever directory that create
/// minted for it. **No write on the renumber path mints anything**: every referencer write goes to a
/// resolved unit's own directory, the flat target's new leaf goes into the group folder its old leaf
/// was already in, and the container target's new leaf is put in place by
/// <see cref="Move"/> rather than created. The gap is therefore latent, not live, and closing it
/// speculatively would mean this class growing exactly the directory bookkeeping the paragraph above
/// says it must not have. A future caller whose writes do mint is the one that has to reopen
/// this.</para></para>
///
/// <para><b>Not a lock and not isolation.</b> A reader mid-action sees whatever is on disk at that
/// moment, and that is fine; what must not happen is a failure leaving something broken behind.</para>
/// </summary>
internal sealed class SourceWriteTransaction
{
    /// <summary>One filesystem act, with enough of the before and after state to undo it. Recorded in
    /// execution order; undone in reverse, which is what lets a group-ordering rename be put back
    /// before the create that provoked it, rather than into a name a sibling still occupies.</summary>
    private abstract record Operation(string ModFolder);

    /// <summary><paramref name="Before"/>/<paramref name="After"/> are the file's bytes, or null for
    /// "no file at this path" — so a create (<c>Before</c> null), an overwrite (both set) and a delete
    /// (<c>After</c> null) are all one shape. <c>After</c> is what is on disk once the act has been
    /// <i>attempted</i>, success or throw, so the operation that failed carries an honest record of
    /// how far it got rather than an assumption.</summary>
    private sealed record FileState(string ModFolder, string Path, byte[]? Before, byte[]? After)
        : Operation(ModFolder);

    private sealed record EntryMove(string ModFolder, string From, string To) : Operation(ModFolder);

    private readonly List<Operation> _log = [];

    /// <summary>
    /// <paramref name="write"/>, run against <paramref name="path"/> with that path's current content
    /// captured first and its resulting content captured after — whether the write returned or threw.
    /// The write itself goes through <see cref="SourceUnitResolver.InMintedDirectory{T}"/>, exactly as
    /// an unjournalled source write does.
    /// </summary>
    internal void Write(string modFolder, string path, Action write)
    {
        var before = Snapshot(path);
        try
        {
            SourceUnitResolver.InMintedDirectory(System.IO.Path.GetDirectoryName(path)!, write);
        }
        finally
        {
            _log.Add(new FileState(modFolder, path, before, Snapshot(path)));
        }
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

    /// <summary>Moves a file or a whole directory, recorded so the rollback can move it back. Only
    /// recorded once the move has actually happened: <c>Directory.Move</c>/<c>File.Move</c> either
    /// rename the entry or leave it where it was, so a throw here leaves nothing to undo.</summary>
    internal void Move(string modFolder, string from, string to)
    {
        SourceUnitResolver.MoveEntry(from, to);
        _log.Add(new EntryMove(modFolder, from, to));
    }

    /// <summary>
    /// Puts every recorded act back, most recent first, and reports the paths it deliberately left
    /// alone or could not restore. An empty result means every source tree this transaction touched is
    /// byte-identical to its pre-action state.
    ///
    /// <para>Reverse order is what makes the restore collision-free: a name this action took is always
    /// vacated by undoing the act that took it before any earlier act is asked to move back into
    /// it.</para>
    ///
    /// <para>A restore failure never stops the pass. The remaining acts are still undone — one
    /// unwritable path must not cost every other tree its restore — and the failure is collected
    /// (ADR-0026) rather than thrown.</para>
    /// </summary>
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
            }
        }

        return unrestored;
    }

    private static void RestoreFile(FileState file, List<UnrestoredPath> unrestored)
    {
        // A path whose content could not be read when the act was made is a path this cannot reason
        // about: "absent" and "unreadable" would otherwise collapse into the same null, and a
        // pre-image that read as absent because the read failed would have the rollback *delete* a
        // file it never created. Reported instead, and left exactly as it stands.
        if (ReferenceEquals(file.Before, Unreadable) || ReferenceEquals(file.After, Unreadable))
        {
            unrestored.Add(Named(file.ModFolder, file.Path, UnrestoredReason.RestoreFailed,
                "its content could not be read while the renumber wrote it, so there is nothing to compare against"));
            return;
        }

        // The act changed nothing — a write that threw before its rename, most often. There is
        // nothing to put back, and nothing to say about the path either: naming a file this action
        // never altered would send the author looking for damage that is not there.
        if (SameBytes(file.Before, file.After)) return;

        var current = Snapshot(file.Path);
        if (ReferenceEquals(current, Unreadable))
        {
            // Checked by reference before any byte comparison: an unreadable file is a zero-length
            // array, and comparing it by value would read as equal to a legitimately empty one and
            // have the rollback write over a file it cannot even see.
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
            SourceUnitResolver.MoveEntry(move.To, move.From);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add(Named(move.ModFolder, move.From, UnrestoredReason.RestoreFailed, ex.Message));
        }
    }

    private static UnrestoredPath Named(string modFolder, string path, UnrestoredReason reason, string? error = null) =>
        new(System.IO.Path.GetRelativePath(modFolder, path), path, reason, error);

    private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    /// <summary>Distinct from both "absent" (null) and any real content: a file that is there and
    /// could not be read. Compared by reference, never by value, so a legitimately empty file is not
    /// mistaken for one.</summary>
    private static readonly byte[] Unreadable = [];

    /// <summary>The file's bytes, null when nothing is there, or <see cref="Unreadable"/> when
    /// something is there that could not be read. A directory standing where a file is expected reads
    /// as null — there is no file content, which is the honest answer, and the rollback's own
    /// pre-image comparison is what keeps it from writing over the directory.</summary>
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
