using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>Documents by identity over one tracked mod folder (ADR-0014), and ADR-0007's
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

    // Read off the ref store's files, not by running git: every read of a tracked plugin asks this.
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

    /// <summary>"Editing requires tracking; viewing never does" (ADR-0007), asked of a plugin's
    /// origin and path.</summary>
    public static bool IsEditable(string origin, string pluginPath) =>
        LoadOrderSnapshot.ModFolderOf(origin, pluginPath) is { } modFolder && IsTracked(modFolder);

    /// <summary>The mod folder only when it is tracked — the single condition under which a plugin
    /// has source text at all.</summary>
    public static string? TrackedModFolderOf(LoadOrderSnapshot loadOrder, PluginAddress plugin) =>
        loadOrder.ModFolderOf(plugin) is { } modFolder && IsTracked(modFolder) ? modFolder : null;

    /// <summary>The record's own text, or null when no document holds it. The identity comes back as
    /// asked; the body is the tree's answer, spliced out of another record's document when that is
    /// what carries it.</summary>
    public SourceDocument? Get(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locate(plugin, identity) is not { } unit || !File.Exists(unit.FullPath)) return null;

        var body = RecordBodyFromOwnerBytes(File.ReadAllBytes(unit.FullPath), unit, identity.FormKey, _release);
        return body == null ? null : new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body);
    }

    /// <summary>Creates or replaces the record's document, placing an absent one from its identity
    /// alone and minting the levels above it. A record another document carries is replaced at its
    /// own slot, every other byte untouched.</summary>
    public void Put(PluginAddress plugin, SourceDocument document) => Put(plugin, document, placement: null);

    /// <summary>The put of an exterior cell, the one record whose directory sits inside another
    /// record's: <paramref name="placement"/> names the worldspace holding it and its block numbers.
    /// Every other record is placed from its identity alone.</summary>
    public void Put(PluginAddress plugin, SourceDocument document, CellPlacement? placement)
    {
        var identity = new RecordIdentity(document.FormKey, document.RecordType, document.EditorId);
        if (LocateToPlace(plugin, identity) is { } held) MoveToItsEditorId(held, document);
        var unit = LocateToPlace(plugin, identity)
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
    public SourceRemoval Remove(PluginAddress plugin, RecordIdentity identity)
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
        var before = PreImageOf(directory);
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (Exception cause) when (cause is IOException or UnauthorizedAccessException)
        {
            var unrestored = PutBack(before);
            if (unrestored.Count == 0) throw;
            throw new IOException(
                $"{cause.Message} Everything it removed is back except: {string.Join(" ", unrestored)}", cause);
        }
    }

    /// <summary>The plugin's source in the working tree becomes <paramref name="files"/>, and the
    /// last-compile ref names only the binary they were read from. A failure leaves both as they
    /// were.</summary>
    public void ReplaceSourceFrom(string pluginFileName, IReadOnlyList<TreeFile> files, string binarySha256)
    {
        // A mod folder another tool removed is not written back into being.
        if (!IsTracked(_modFolder))
            throw new InvalidOperationException($"'{_modFolder}' holds no repository, so {pluginFileName}'s source has nowhere to go.");

        var root = RootIn(_modFolder, pluginFileName);
        var before = Directory.Exists(root) ? PreImageOf(root) : new PreImage([], []);
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
            PristineFileWriter.WriteAll(files, _modFolder);
            ParkDecompiled(pluginFileName, binarySha256);
        }
        catch (Exception cause) when (cause is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            var unrestored = new List<string>();
            TryPutBack(root, () => { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }, unrestored);
            unrestored.AddRange(PutBack(before));
            if (unrestored.Count == 0) throw;
            throw new IOException(
                $"{cause.Message} Its source is back as it was except: {string.Join(" ", unrestored)}", cause);
        }
        finally
        {
            Forget();
        }
    }

    // What the working tree now holds was made from this binary, as a landed compile's is. The
    // snapshot takes the plugin's whole source, which git may not track yet.
    private void ParkDecompiled(string plugin, string binarySha256)
    {
        var gitDir = Path.Combine(_modFolder, ".git");
        var headSha = GitCli.Run(gitDir, _modFolder, "rev-parse", "HEAD").Trim();
        var tree = WorkingTreeSnapshotTree(gitDir, _modFolder, LiteralPathspec(RootFor(plugin)));
        Repark(gitDir, _modFolder, "Decompile", plugin, tree, headSha, [$"{BinaryTrailer}: {binarySha256}"]);
    }

    private sealed record PreImage(List<string> Directories, List<(string Path, byte[] Bytes)> Files);

    private static PreImage PreImageOf(string directory) => new(
        [.. Directory.GetDirectories(directory, "*", SearchOption.AllDirectories)
            .Prepend(directory)
            .Order(StringComparer.Ordinal)],
        [.. Directory.GetFiles(directory, "*", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .Select(path => (Path: path, Bytes: File.ReadAllBytes(path)))]);

    // One path that cannot be written never stops the pass (ADR-0019): every other one is still put back.
    private List<string> PutBack(PreImage before)
    {
        var unrestored = new List<string>();
        foreach (var level in before.Directories)
        {
            TryPutBack(level, () => Directory.CreateDirectory(level), unrestored);
        }
        foreach (var (path, bytes) in before.Files.Where(file => !File.Exists(file.Path)))
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

    // Move before write: a crash between leaves the record at its new name with old content, still
    // found by FormKey. A leaf something else renamed keeps its name while the EditorID is unchanged.
    private void MoveToItsEditorId(SourceUnit unit, SourceDocument document)
    {
        if (!ChangesEditorId(unit, document)) return;

        var from = unit.IsDirectoryPerRecord ? PathShape.DirectoryOf(unit.FullPath) : unit.FullPath;
        var to = Path.Combine(
            PathShape.DirectoryOf(from),
            LeafNameFor(FormKey.Factory(document.FormKey), document.EditorId, unit.IsDirectoryPerRecord));
        if (string.Equals(from, to, StringComparison.Ordinal)) return;

        if (unit.IsDirectoryPerRecord) Directory.Move(from, to);
        else File.Move(from, to, overwrite: true);
        Forget();
    }

    /// <summary>Whether putting <paramref name="document"/> would rename the file it replaces. Refuses
    /// a file whose text is not a document: its EditorID cannot be compared, and overwriting it would
    /// drop what something else wrote.</summary>
    internal static bool ChangesEditorId(SourceUnit unit, SourceDocument document)
    {
        if (document.RecordType == PluginHeader.RecordType || unit.IsEmbedded || !File.Exists(unit.FullPath))
            return false;

        var text = File.ReadAllText(unit.FullPath);
        if (NotADocument(text) is { } why)
            throw new InvalidOperationException($"{unit.RelativePath} is not a readable document, so its EditorID cannot be compared: {why}");
        return !string.Equals(EditorIdOf(text), document.EditorId, StringComparison.Ordinal);
    }

    private static string? EditorIdOf(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty(RecordMembers.EditorId, out var editorId)
            && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }

    private static byte[] OwnerBytes(SourceUnit unit) => StripUtf8Bom(File.ReadAllBytes(unit.FullPath));

    private static InvalidOperationException NoPlaceInTheTree(PluginAddress plugin, RecordIdentity identity) =>
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

    /// <summary>One file's text at <paramref name="gitRef"/>, or null. cat-file -p, not git show: for
    /// a missing glob-shaped path, show exits 0 with empty output — a lying empty string.</summary>
    internal static string? ReadCommittedSourceText(string modFolder, string relativePath, string gitRef = "HEAD")
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        return GitCli.TryRun(gitDir, modFolder, out var stdout, "cat-file", "-p", $"{gitRef}:{ToGitPath(relativePath)}")
            ? stdout
            : null;
    }

    /// <summary>Parks the working tree about to be compiled, naming its binary beside every binary the
    /// ref already names, so an interrupted write leaves one it names (plugins.md, Compile, story 5).
    /// Moves no HEAD, branch or index.</summary>
    public static void ParkCompileSnapshot(string modFolder, string plugin, string binarySha256)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        var headSha = GitCli.Run(gitDir, modFolder, "rev-parse", "HEAD").Trim();
        var tree = WorkingTreeSnapshotTree(gitDir, modFolder);
        var earlier = ParkedCompileBinarySha256s(modFolder, plugin);
        Repark(gitDir, modFolder, "Compile", plugin, tree, headSha, [$"{BinaryTrailer}: {binarySha256}",
            .. earlier.Select(sha => $"{EarlierBinaryTrailer}: {sha}")]);
    }

    /// <summary>The compiled binary is written, so the parked snapshot names it alone (ADR-0003).</summary>
    public static void NarrowCompileSnapshot(string modFolder, string plugin)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        var parked = LastCompileRef(plugin);
        var body = GitCli.Run(gitDir, modFolder, "log", "-1", "--format=%B", parked);
        var tree = GitCli.Run(gitDir, modFolder, "rev-parse", $"{parked}^{{tree}}").Trim();
        var parent = GitCli.Run(gitDir, modFolder, "rev-parse", $"{parked}^").Trim();
        Repark(gitDir, modFolder, "Compile", plugin, tree, parent,
            [.. ReadTrailers(body, BinaryTrailer).Select(sha => $"{BinaryTrailer}: {sha}")]);
    }

    // commit-tree is plumbing with no --trailer flag, so the trailer block is hand-written. The
    // subject names the gesture that made the snapshot.
    private static void Repark(
        string gitDir, string modFolder, string gesture, string plugin, string tree, string parent, IEnumerable<string> trailers)
    {
        var message = string.Join('\n', [$"{gesture}: {plugin}", "", .. trailers]);
        var snapshotSha = GitCli.Run(gitDir, modFolder, "commit-tree", tree, "-p", parent, "-m", message).Trim();
        GitCli.Run(gitDir, modFolder, "update-ref", LastCompileRef(plugin), snapshotSha);
    }

    private const string BinaryTrailer = "Binary-SHA256";
    private const string EarlierBinaryTrailer = "Earlier-Binary-SHA256";

    // The index, every tracked file's working-tree bytes and every file under the pathspecs, on a copy
    // of the index: git stash create would take index.lock, which the user's commit may hold.
    private static string WorkingTreeSnapshotTree(string gitDir, string workTree, params string[] alsoTaking)
    {
        var scratchIndex = Path.Combine(Path.GetTempPath(), $"medit-snapshot-index-{Guid.NewGuid():N}");
        try
        {
            File.Copy(Path.Combine(gitDir, "index"), scratchIndex);
            GitCli.RunWithIndex(gitDir, workTree, scratchIndex, "add", "-u");
            if (alsoTaking.Length > 0) GitCli.RunWithIndex(gitDir, workTree, scratchIndex, ["add", "-A", "--", .. alsoTaking]);
            return GitCli.RunWithIndex(gitDir, workTree, scratchIndex, "write-tree").Trim();
        }
        finally
        {
            if (File.Exists(scratchIndex)) File.Delete(scratchIndex);
        }
    }

    /// <summary>Each path under the plugin's tree that git status names, with its index-column code;
    /// null when git cannot say. It names both ends of a move and every untracked or ignored
    /// file.</summary>
    internal static IReadOnlyList<(char Code, string Path)>? WorkingTreeStatus(string modFolder, string pluginFileName)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        if (!GitCli.TryRun(gitDir, modFolder, out var stdout,
                "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored",
                "--", LiteralPathspec(RootFor(pluginFileName))))
        {
            return null;
        }

        var entries = new List<(char, string)>();
        foreach (var entry in stdout.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            // "XY path": a shorter entry is one this parse cannot read.
            if (entry.Length < 4) return null;
            entries.Add((entry[0], entry[3..]));
        }
        return entries;
    }

    /// <summary>Every binary hash the plugin's last-compile ref names: a baseline's or a landed
    /// compile's one, or an unfinished compile's with those before it. Empty when the ref is
    /// missing.</summary>
    public static IReadOnlyList<string> ParkedCompileBinarySha256s(string modFolder, string plugin)
    {
        if (!IsTracked(modFolder)) return [];

        var gitDir = Path.Combine(modFolder, ".git");
        if (!GitCli.TryRun(gitDir, modFolder, out var body, "log", "-1", "--format=%B", LastCompileRef(plugin)))
            return [];

        return [.. ReadTrailers(body, BinaryTrailer), .. ReadTrailers(body, EarlierBinaryTrailer)];
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
