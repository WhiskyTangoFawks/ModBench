using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>Documents by identity over one tracked mod folder (ADR-0014 invariant 5), and ADR-0007's
/// git verbs beneath them. Every verb tolerates the folder having vanished since last observed —
/// MO2's Replace install shell-deletes mod folders.</summary>
public sealed partial class SourceRepository
{
    private readonly string _modFolder;
    private readonly GameRelease _release;

    /// <summary>The folder this repository is over, for a caller naming a path relative to it.</summary>
    public string ModFolder => _modFolder;

    // Private so a repository comes from one of the two named doors, each stating what it observed:
    // Open, which found a tracked folder, or Over, which established that or did not need it.
    private SourceRepository(string modFolder, GameRelease release) =>
        (_modFolder, _release) = (modFolder, release);

    /// <summary>The repository over <paramref name="modFolder"/>, or null when the folder is not
    /// tracked and so has no source tree to answer from. <paramref name="release"/> is the game
    /// whose record types name the tree's group folders.</summary>
    public static SourceRepository? Open(string modFolder, GameRelease release) =>
        IsTracked(modFolder) ? new SourceRepository(modFolder, release) : null;

    /// <summary>The repository over a folder whose tracked state the caller has already established,
    /// or does not need: the document verbs answer either way, and a git verb over an untracked folder
    /// answers empty rather than throwing.</summary>
    public static SourceRepository Over(string root, GameRelease release) => new(root, release);

    /// <summary>True exactly when <paramref name="modFolder"/> holds a repository whose <c>main</c>
    /// exists. A <c>.git</c> with no <c>main</c> is Track's own, half made, or
    /// <see cref="HoldsAnotherRepository"/>.</summary>
    public static bool IsTracked(string modFolder)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        return Directory.Exists(gitDir) && HasMainBranch(gitDir);
    }

    /// <summary>A repository with history but no <c>main</c>: someone else's, which Track never
    /// writes to (ADR-0003). A <c>.git</c> with no branch at all is Track's own, half made.</summary>
    public static bool HoldsAnotherRepository(string modFolder)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        return Directory.Exists(gitDir) && !HasMainBranch(gitDir) && HasAnyBranch(gitDir);
    }

    // Read off the ref store's files, not by running git: every read of a tracked copy asks this.
    // A branch is a loose ref file until git packs it into packed-refs.
    private static bool HasMainBranch(string gitDir) =>
        File.Exists(Path.Combine(gitDir, "refs", "heads", "main")) || PackedBranches(gitDir).Contains("main");

    private static bool HasAnyBranch(string gitDir)
    {
        var heads = Path.Combine(gitDir, "refs", "heads");
        // A .lock file is a ref being written, never a ref.
        return (Directory.Exists(heads) && Directory.EnumerateFiles(heads, "*", SearchOption.AllDirectories).Any(file => !file.EndsWith(".lock", StringComparison.Ordinal)))
            || PackedBranches(gitDir).Count > 0;
    }

    private static HashSet<string> PackedBranches(string gitDir)
    {
        const string prefix = " refs/heads/";
        var packedRefs = Path.Combine(gitDir, "packed-refs");
        if (!File.Exists(packedRefs)) return [];
        return [.. File.ReadLines(packedRefs)
            .Select(line => line.IndexOf(prefix, StringComparison.Ordinal) is var at and >= 0 ? line[(at + prefix.Length)..] : null)
            .OfType<string>()];
    }

    /// <summary>"Editing requires tracking; viewing never does" (ADR-0007), asked of a copy's origin
    /// and path.</summary>
    public static bool IsEditable(string origin, string pluginPath) =>
        LoadOrderSnapshot.ModFolderOf(origin, pluginPath) is { } modFolder && IsTracked(modFolder);

    /// <summary>The mod folder only when it is tracked — the single condition under which a plugin
    /// has source text at all.</summary>
    public static string? TrackedModFolderOf(LoadOrderSnapshot loadOrder, PluginCopyKey plugin) =>
        loadOrder.ModFolderOf(plugin) is { } modFolder && IsTracked(modFolder) ? modFolder : null;

    /// <summary>The record's own text, or null when no document holds it. The identity comes back as
    /// asked; the body is the tree's answer, spliced out of another record's document when that is
    /// what carries it.</summary>
    public SourceDocument? Get(PluginCopyKey plugin, RecordIdentity identity)
    {
        if (Locate(plugin, identity) is not { } unit || !File.Exists(unit.FullPath)) return null;

        var body = RecordBodyFromOwnerBytes(File.ReadAllBytes(unit.FullPath), unit, identity.FormKey, _release);
        return body == null ? null : new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body);
    }

    /// <summary>Creates or replaces the record's document, placing an absent one from its identity
    /// alone and minting the levels above it. A record another document carries is replaced at its
    /// own slot, every other byte untouched.</summary>
    public void Put(PluginCopyKey plugin, SourceDocument document) => Put(plugin, document, placement: null);

    /// <summary>The put of an exterior cell, the one record whose directory sits inside another
    /// record's: <paramref name="placement"/> names the worldspace holding it and its block numbers.
    /// Every other record is placed from its identity alone.</summary>
    public void Put(PluginCopyKey plugin, SourceDocument document, CellPlacement? placement)
    {
        var identity = new RecordIdentity(document.FormKey, document.RecordType, document.EditorId);
        var unit = Locate(plugin, identity)
                   ?? PlaceNewDocument(plugin, identity, placement)
                   ?? throw NoPlaceInTheTree(plugin, identity);

        if (unit.IsEmbedded)
        {
            var ownerBytes = OwnerBytes(unit);
            if (EmbeddedChildIn(ownerBytes, unit, document.FormKey, _release) is not { } span)
                throw NoLongerCarried(unit, document.FormKey);

            WriteTextAtomic(unit.FullPath, EmbeddedChildSplice.Replace(ownerBytes, span, document.Body));
            Forget();
            return;
        }

        InMintedDirectory(
            PathShape.DirectoryOf(unit.FullPath), () => WriteTextAtomic(unit.FullPath, document.Body));
        Forget();
    }

    /// <summary>Takes the record out of the tree: its file, its directory, or its element of another
    /// record's document. Already gone is the state asked for; the other two outcomes say what
    /// stopped it.</summary>
    public SourceRemoval Remove(PluginCopyKey plugin, RecordIdentity identity)
    {
        if (Locate(plugin, identity) is not { } unit) return SourceRemoval.NoDocumentHoldsIt;

        if (unit.IsEmbedded)
        {
            var ownerBytes = OwnerBytes(unit);
            if (EmbeddedChildIn(ownerBytes, unit, identity.FormKey, _release) is not { } span)
                return SourceRemoval.OwnerDoesNotCarryIt;

            WriteTextAtomic(unit.FullPath, EmbeddedChildSplice.Cut(ownerBytes, span));
            Forget();
            return SourceRemoval.Removed;
        }

        if (unit.IsDirectoryPerRecord)
        {
            var directory = PathShape.DirectoryOf(unit.FullPath);
            if (Directory.Exists(directory)) DeleteWholeOrNotAtAll(directory);
            Forget();
            return SourceRemoval.Removed;
        }

        if (File.Exists(unit.FullPath)) File.Delete(unit.FullPath);
        Forget();
        return SourceRemoval.Removed;
    }

    // A failed recursive delete goes on past the entry it could not take, so it stops partway. The
    // pre-image puts back what went; a file still standing is left alone, as this delete never wrote it.
    private void DeleteWholeOrNotAtAll(string directory)
    {
        var directories = Directory.GetDirectories(directory, "*", SearchOption.AllDirectories)
            .Prepend(directory)
            .Order(StringComparer.Ordinal)
            .ToList();
        var files = Directory.GetFiles(directory, "*", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .Select(path => (Path: path, Bytes: File.ReadAllBytes(path)))
            .ToList();
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (Exception cause) when (cause is IOException or UnauthorizedAccessException)
        {
            var unrestored = PutBack(directories, files);
            if (unrestored.Count == 0) throw;
            throw new IOException(
                $"{cause.Message} Everything it removed is back except: {string.Join(" ", unrestored)}", cause);
        }
    }

    // One path that cannot be written never stops the pass (ADR-0019): every other one is still put back.
    private List<string> PutBack(List<string> directories, List<(string Path, byte[] Bytes)> files)
    {
        var unrestored = new List<string>();
        foreach (var level in directories)
        {
            TryPutBack(level, () => Directory.CreateDirectory(level), unrestored);
        }
        foreach (var (path, bytes) in files.Where(file => !File.Exists(file.Path)))
        {
            TryPutBack(path, () => File.WriteAllBytes(path, bytes), unrestored);
        }
        return unrestored;
    }

    private void TryPutBack(string path, Action write, List<string> unrestored)
    {
        try
        {
            write();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add($"{Path.GetRelativePath(_modFolder, path)} could not be put back: {ex.Message}");
        }
    }

    /// <summary>Moves the record's file or directory to the name <paramref name="newEditorId"/>
    /// computes, and answers the leaf it now has. Null when nothing moved: the header and an inlined
    /// record have no leaf name of their own.</summary>
    public string? Rename(PluginCopyKey plugin, RecordIdentity identity, string? newEditorId)
    {
        if (identity.RecordType == PluginHeader.RecordType) return null;
        // The name it already has, so nothing moves — and a leaf something else renamed keeps that
        // name rather than being dragged back to the computed one.
        if (string.Equals(newEditorId, identity.EditorId, StringComparison.Ordinal)) return null;
        if (Locate(plugin, identity) is not { IsEmbedded: false } unit) return null;

        var from = unit.IsDirectoryPerRecord ? PathShape.DirectoryOf(unit.FullPath) : unit.FullPath;
        var to = Path.Combine(
            PathShape.DirectoryOf(from),
            LeafNameFor(
                FormKey.Factory(identity.FormKey), newEditorId, unit.IsDirectoryPerRecord));
        if (string.Equals(from, to, StringComparison.Ordinal)) return null;

        if (unit.IsDirectoryPerRecord)
        {
            if (!Directory.Exists(from)) return null;
            Directory.Move(from, to);
        }
        else
        {
            if (!File.Exists(from)) return null;
            File.Move(from, to, overwrite: true);
        }
        Forget();
        return Path.GetFileName(to);
    }

    private static byte[] OwnerBytes(SourceUnit unit) => StripUtf8Bom(File.ReadAllBytes(unit.FullPath));

    private static InvalidOperationException NoPlaceInTheTree(PluginCopyKey plugin, RecordIdentity identity) =>
        new($"No document in {plugin.Name}'s tree holds {identity.FormKey}, and its type has no file of " +
            "its own, so there is nowhere to write it.");

    private static InvalidOperationException NoLongerCarried(SourceUnit unit, string formKey) =>
        new($"{unit.RelativePath} was found holding {formKey}, but its own text does not carry it.");

    /// <summary>Throws <see cref="GitUnavailableException"/> when git cannot be run, so no repository
    /// can be made or written here.</summary>
    public static void EnsureTrackable() => GitCli.EnsureOnPath();

    /// <summary>Object names as <c>HEAD</c> has them (<c>git ls-tree</c>, one process per batch) — not
    /// working-tree status, which diverges after the external commits this exists for. Directly
    /// comparable to records.content_hash. Null when untracked.</summary>
    internal static IReadOnlyDictionary<string, string>? CommittedSourceHashes(
        string modFolder, IReadOnlyList<string> relativePaths)
    {
        if (!IsTracked(modFolder) || relativePaths.Count == 0) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        string[] args = ["ls-tree", "-z", "HEAD", "--", .. relativePaths.Select(ToGitPath)];
        // TryRun, not Run: an unborn HEAD (a repo whose branch has no commit yet) is a real state,
        // and "nothing is committed" is an answer here, not a failure to report.
        if (!GitCli.TryRun(gitDir, modFolder, out var stdout, args)) return null;

        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        // -z so paths carrying spaces or non-ASCII survive verbatim; git otherwise quotes and escapes
        // them, and every source path segment comes from a plugin filename.
        foreach (var entry in stdout.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            // "<mode> SP <type> SP <object> TAB <file>"
            var tab = entry.IndexOf('\t', StringComparison.Ordinal);
            if (tab < 0) continue;
            var fields = entry[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 3 || fields[1] != "blob") continue;
            hashes[entry[(tab + 1)..]] = fields[2];
        }
        return hashes;
    }

    /// <summary>Every blob under one plugin's committed source subtree, path to object name, from one
    /// <c>ls-tree</c>. Null, never an empty map, when the tree could not be read at all: what tells
    /// absence from silence.</summary>
    public static IReadOnlyDictionary<string, string>? CommittedSourceTree(string modFolder, string pluginFileName)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        var sourcePrefix = ToGitPath(RootFor(pluginFileName));
        if (!GitCli.TryRun(gitDir, modFolder, out var stdout, "ls-tree", "-r", "-z", "HEAD", "--", $"{sourcePrefix}/"))
            return null;

        var blobs = new Dictionary<string, string>(StringComparer.Ordinal);
        // -z for the same reason CommittedSourceHashes uses it: every source path segment comes from a
        // plugin filename or an EditorID, either of which may carry a space.
        foreach (var entry in stdout.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            // "<mode> SP <type> SP <object> TAB <file>"
            var tab = entry.IndexOf('\t', StringComparison.Ordinal);
            if (tab < 0) continue;
            var fields = entry[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 3 || fields[1] != "blob") continue;
            blobs[entry[(tab + 1)..]] = fields[2];
        }
        return blobs;
    }

    /// <summary>One file's text as HEAD has it, or null. cat-file -p, not git show: for a missing
    /// glob-shaped path, show applies pathspec magic and exits 0 with empty output — a lying empty
    /// string, not null.</summary>
    internal static string? ReadCommittedSourceText(string modFolder, string relativePath)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        return GitCli.TryRun(gitDir, modFolder, out var stdout, "cat-file", "-p", $"HEAD:{ToGitPath(relativePath)}")
            ? stdout
            : null;
    }

    /// <summary>Re-parks the last-compile ref at the tree just compiled from, without moving HEAD, branch
    /// or index (ADR-0007). Null <paramref name="atRef"/> snapshots the working tree; a ref name
    /// snapshots that ref's tree.</summary>
    public static void ParkCompileSnapshot(
        string modFolder, string plugin, string? atRef, string binarySha256)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        var headSha = GitCli.Run(gitDir, modFolder, "rev-parse", "HEAD").Trim();

        var tree = atRef == null
            ? WorkingTreeSnapshotTree(gitDir, modFolder, headSha)
            : GitCli.Run(gitDir, modFolder, "rev-parse", $"{atRef}^{{tree}}").Trim();

        // commit-tree is plumbing with no --trailer flag, so the trailer line is hand-written at the message
        // tail.
        var message = $"Save & Compile: {plugin}\n\nBinary-SHA256: {binarySha256}";
        var snapshotSha = GitCli.Run(gitDir, modFolder, "commit-tree", tree, "-p", headSha, "-m", message).Trim();
        GitCli.Run(gitDir, modFolder, "update-ref", LastCompileRef(plugin), snapshotSha);
    }

    // git stash create answers empty, not an error, when the working tree matches the index; HEAD's own
    // tree is then the snapshot.
    private static string WorkingTreeSnapshotTree(string gitDir, string workTree, string headSha)
    {
        if (!GitCli.TryRun(gitDir, workTree, out var stashSha, "stash", "create") || string.IsNullOrWhiteSpace(stashSha))
            return GitCli.Run(gitDir, workTree, "rev-parse", $"{headSha}^{{tree}}").Trim();

        return GitCli.Run(gitDir, workTree, "rev-parse", $"{stashSha.Trim()}^{{tree}}").Trim();
    }

    /// <summary>Stages every changed tracked file on the real repo — index matches working tree —
    /// so the same bytes cannot re-raise the question once answered (ADR-0003).</summary>
    public static void StageTrackedFileChanges(string modFolder, IReadOnlyList<TrackedFileChange> changes)
    {
        if (changes.Count == 0) return;
        var gitDir = Path.Combine(modFolder, ".git");
        var paths = changes.Select(c => ToGitPath(c.RelativePath)).ToArray();
        GitCli.Run(gitDir, modFolder, ["add", "-A", "--", .. paths]);
    }

    /// <summary>The edit branch replayed onto main's new tip. Refuses over dirt in the source tree;
    /// a tracked file outside it rides `--autostash` (ADR-0003). Mid-rebase delegates to
    /// <see cref="ContinueRebase"/>.</summary>
    public static RebaseResult RebaseEditBranch(string modFolder)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        if (RebaseInProgress(gitDir))
            return ContinueRebase(modFolder);

        var sourcePrefix = ToGitPath(RootFolderName) + "/";
        var dirty = WorkingTreeStatus(modFolder).Where(p => p.StartsWith(sourcePrefix, StringComparison.Ordinal)).ToList();
        if (dirty.Count > 0)
        {
            return RebaseResult.Refused(
                $"Cannot rebase: uncommitted changes in {string.Join(", ", dirty)}. " +
                "Commit, stash, or discard them first, then try again.");
        }

        // Captured before the autostash round-trip: a successful pop restores content but not
        // reliably the staged bit, so a path Absorb/Keep staged as its own answer is re-staged below.
        var stagedBefore = ParseStatus(modFolder).Where(e => e.IndexStatus is not (' ' or '?')).Select(e => e.Path).ToList();
        var stashCountBefore = StashCount(gitDir, modFolder);

        // -c core.editor=true: a clean, non-conflicted rebase never needs a message editor, but this
        // keeps the call non-interactive regardless — nothing here has a terminal to hand one to.
        if (GitCli.TryRun(gitDir, modFolder, out _, "-c", "core.editor=true", "rebase", "--autostash", "refs/heads/main"))
        {
            // Exit 0 even when re-applying the autostash itself conflicted: git keeps the stash and
            // leaves conflict markers rather than losing the change. A new stash entry is the tell.
            if (StashCount(gitDir, modFolder) > stashCountBefore)
            {
                return RebaseResult.Conflicted(
                    ConflictedPaths(gitDir, modFolder),
                    "The rebase replayed cleanly, but re-applying its autostashed tracked-file changes " +
                    "conflicted. Nothing was lost — they are kept in `git stash list` — resolve the " +
                    "conflict markers, stage them, then run `git stash drop`.");
            }

            // A path the replay fully resolved (its diff now matches new main, deletion included) is
            // gone from status entirely — restaging it by name would be an unmatched pathspec.
            var stillDirty = ParseStatus(modFolder).Select(e => e.Path).ToHashSet(StringComparer.Ordinal);
            var toRestage = stagedBefore.Where(stillDirty.Contains).ToList();
            if (toRestage.Count > 0) GitCli.Run(gitDir, modFolder, ["add", "-A", "--", .. toRestage]);
            return RebaseResult.Clean();
        }

        return RebaseResult.Conflicted(ConflictedPaths(gitDir, modFolder));
    }

    private static int StashCount(string gitDir, string workTree) =>
        GitCli.TryRun(gitDir, workTree, out var stdout, "stash", "list")
            ? stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length
            : 0;

    private static bool RebaseInProgress(string gitDir) =>
        Directory.Exists(Path.Combine(gitDir, "rebase-merge")) || Directory.Exists(Path.Combine(gitDir, "rebase-apply"));

    /// <summary>Stages whatever the working tree now holds and continues: this repo's tree is
    /// source-JSON-only, so a blanket <c>add -A</c> is exactly the resolution the user just wrote.</summary>
    public static RebaseResult ContinueRebase(string modFolder)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        GitCli.Run(gitDir, modFolder, "add", "-A");

        if (GitCli.TryRun(gitDir, modFolder, out _, "-c", "core.editor=true", "rebase", "--continue"))
            return RebaseResult.Clean();

        return RebaseResult.Conflicted(ConflictedPaths(gitDir, modFolder));
    }

    private static List<string> ConflictedPaths(string gitDir, string workTree) =>
        GitCli.TryRun(gitDir, workTree, out var stdout, "diff", "--name-only", "--diff-filter=U")
            ? stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).ToList()
            : [];

    /// <summary>Every path git status considers dirty, staged or not. Empty when untracked or
    /// clean.</summary>
    internal static IReadOnlyList<string> WorkingTreeStatus(string modFolder) =>
        [.. ParseStatus(modFolder).Select(e => e.Path)];

    /// <summary>"Changed tracked files" (ADR-0003 invariant 3): every path outside the source
    /// root whose working tree differs from the index, git's view; a change staged and untouched
    /// since is an answer, not a question. Assets under Everything.</summary>
    public static IReadOnlyList<TrackedFileChange> ChangedTrackedFilesOutsideSource(string modFolder)
    {
        var sourcePrefix = ToGitPath(RootFolderName) + "/";
        return [.. ParseStatus(modFolder)
            .Where(e => !e.Path.StartsWith(sourcePrefix, StringComparison.Ordinal) && e.WorktreeStatus != ' ')
            .Select(e => new TrackedFileChange(
                e.Path,
                e.IndexStatus == 'D' || e.WorktreeStatus == 'D' ? TrackedFileChangeKind.Deleted : TrackedFileChangeKind.Modified,
                e.IndexStatus is not (' ' or '?')))];
    }

    // A rename/copy's old path rides a second NUL-terminated token with no code of its own — dropped
    // below rather than misread as an unrelated entry.
    private readonly record struct StatusEntry(string Path, char IndexStatus, char WorktreeStatus);

    private static List<StatusEntry> ParseStatus(string modFolder)
    {
        if (!IsTracked(modFolder)) return [];

        var gitDir = Path.Combine(modFolder, ".git");
        if (!GitCli.TryRun(gitDir, modFolder, out var stdout, "status", "--porcelain=v1", "-z")) return [];

        var entries = new List<StatusEntry>();
        var tokens = stdout.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        var i = 0;
        while (i < tokens.Length)
        {
            var entry = tokens[i];
            i++;
            if (entry.Length < 4) continue;
            entries.Add(new StatusEntry(entry[3..], entry[0], entry[1]));
            if (entry[0] is 'R' or 'C') i++;
        }
        return entries;
    }

    /// <summary>The Binary-SHA256 trailer off the plugin's last-compile ref, a baseline or a compile
    /// snapshot, each holding one plugin. Null degrades to asking the dialog.</summary>
    public static string? ParkedCompileBinarySha256(string modFolder, string plugin)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        if (!GitCli.TryRun(gitDir, modFolder, out var body, "log", "-1", "--format=%B", LastCompileRef(plugin)))
            return null;

        return ReadTrailer(body, "Binary-SHA256");
    }

    /// <summary>Whether <paramref name="observedBytes"/> is the exact binary Modbench's own last
    /// compile parked for <paramref name="plugin"/>. A missing parked ref is never a match.</summary>
    public static bool MatchesParkedCompileBinary(string modFolder, string plugin, byte[] observedBytes)
    {
        var observedSha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(observedBytes));
        var parkedSha256 = ParkedCompileBinarySha256(modFolder, plugin);
        return parkedSha256 != null
            && string.Equals(observedSha256, parkedSha256, StringComparison.OrdinalIgnoreCase);
    }

    // git speaks forward slashes on every platform, Windows included, while the layout builds
    // its paths with Path.Combine.
    internal static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    /// <summary>The one place <c>refs/medit/last-compile/&lt;plugin&gt;</c> is built. Almost every real
    /// plugin name is ref-unsafe, so the filename is percent-encoded: injective, but deliberately not
    /// reversible — nothing enumerates these refs.</summary>
    public static string LastCompileRef(string plugin)
    {
        // An empty name is an upstream bug: encoding it would yield a ref ending in "/", which git rejects
        // too.
        if (string.IsNullOrEmpty(plugin))
            throw new ArgumentException("Plugin filename must not be empty.", nameof(plugin));

        return $"refs/medit/last-compile/{EncodeRefComponent(plugin)}";
    }

    // Percent-encodes every byte outside ASCII alnum/-/_, plus '.' where a literal one would make a
    // component git rejects (leading, trailing, "..", trailing ".lock"). '%' is always escaped, which
    // keeps this injective.
    private static string EncodeRefComponent(string plugin)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(plugin);
        var endsWithDotLock = bytes.Length >= 5
            && bytes[^5] == (byte)'.' && bytes[^4] == (byte)'l' && bytes[^3] == (byte)'o'
            && bytes[^2] == (byte)'c' && bytes[^1] == (byte)'k';

        var sb = new System.Text.StringBuilder(bytes.Length);
        for (var i = 0; i < bytes.Length; i++)
        {
            var b = bytes[i];
            var isDot = b == (byte)'.';
            var dotIsSafe = isDot && i != 0 && i != bytes.Length - 1 && bytes[i - 1] != (byte)'.'
                && !(endsWithDotLock && i == bytes.Length - 5);
            var safe = (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9')
                || b == '-' || b == '_' || dotIsSafe;
            if (safe) sb.Append((char)b);
            else sb.Append('%').Append(b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

}

/// <summary>Why a record is or is not out of the tree — three states a caller must tell apart, since
/// "no document holds it" and "the owner's own text lacks it" send the author to different
/// places.</summary>
public enum SourceRemoval
{
    /// <summary>The tree does not hold it, including the record that was already gone.</summary>
    Removed,

    /// <summary>Nothing in the tree holds it, so there was nothing to take out.</summary>
    NoDocumentHoldsIt,

    /// <summary>A document was found holding it, but that document's own text does not carry it.</summary>
    OwnerDoesNotCarryIt,
}

/// <summary>One record as the Source tree holds it: its identity and its own text, byte for byte
/// (ADR-0007).</summary>
public sealed record SourceDocument(string FormKey, string RecordType, string? EditorId, string Body);

/// <summary>One tracked file outside the source root that git status finds dirty — the asset half of
/// an external change (ADR-0003). <see cref="StagedAlready"/> is Keep's own collision
/// signal: a path a prior answer already staged.</summary>
public sealed record TrackedFileChange(string RelativePath, TrackedFileChangeKind Kind, bool StagedAlready);

public enum TrackedFileChangeKind
{
    Modified,
    Deleted,
}
