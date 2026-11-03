using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>The git repository holding one source folder (ADR-0007), its own or the modlist repository: whether it is a
/// source mod, what it committed, and the refs naming the binary Modbench last wrote.</summary>
internal abstract class SourceRepositoryGit
{
    private const string BinaryTrailer = "Binary-SHA256";
    private const string EarlierBinaryTrailer = "Earlier-Binary-SHA256";
    private const string EmptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    private readonly string _sourceFolder;
    private readonly string _workTree;
    private readonly string _gitDir;

    private SourceRepositoryGit(string sourceFolder, string workTree) =>
        (_sourceFolder, _workTree, _gitDir) = (sourceFolder, workTree, GitDirOf(workTree));

    /// <summary>The repository of the source folder's own <c>.git</c>, made yet or not.</summary>
    internal static SourceRepositoryGit Own(string sourceFolder) => new OwnRepository(sourceFolder);

    /// <summary>The modlist repository, the nearest one above the source folder, as git finds it.</summary>
    internal static SourceRepositoryGit Above(string sourceFolder) => new RepositoryAbove(sourceFolder, WorkTreeAbove(sourceFolder) ?? sourceFolder);

    /// <summary>The repository that holds the source folder: its own, else the one above it.</summary>
    internal static SourceRepositoryGit Holding(string sourceFolder) => HoldsGit(sourceFolder) ? Own(sourceFolder) : Above(sourceFolder);

    private protected abstract string SourceFolderInWorkTree { get; }

    /// <summary>The pathspec that limits an add or a commit to the source folder.</summary>
    internal abstract string[] FolderPaths { get; }

    /// <summary>Makes the repository ready to take the source folder's files, undone by <paramref name="journal"/>.</summary>
    internal abstract void BeginInit(WriteJournal journal);

    /// <summary>Marks an init that took the source folder's files as finished.</summary>
    internal abstract void FinishInit();

    // The commit a clone builds the source folder from; empty when the repository holds none of it.
    private protected abstract string SourceCommit();

    private sealed class OwnRepository(string sourceFolder) : SourceRepositoryGit(sourceFolder, sourceFolder)
    {
        private protected override string SourceFolderInWorkTree => "";

        internal override string[] FolderPaths => [];

        internal override void BeginInit(WriteJournal journal)
        {
            if (!Exists) journal.RecordUndo(() => { if (Exists) Delete(); }, path: GitDirectory);
            GitInit.CreateRepository(this);
        }

        internal override void FinishInit() => Run("config", $"{InitMarkSection}.{InitMarkKey}", InitDone);

        // The modlist repository pins HEAD.
        private protected override string SourceCommit() => "HEAD";
    }

    private sealed class RepositoryAbove(string sourceFolder, string workTree) : SourceRepositoryGit(sourceFolder, workTree)
    {
        private string? _sourceFolderInWorkTree;

        private protected override string SourceFolderInWorkTree => _sourceFolderInWorkTree ??= Run("rev-parse", "--show-prefix").Trim();

        internal override string[] FolderPaths => ["--", "."];

        internal override void BeginInit(WriteJournal journal)
        {
            if (!Exists) throw SourceStopException.Inaccessible($"no repository holds '{_sourceFolder}', so it cannot be put in the modlist repository");
            var head = HeadCommit();
            journal.RecordUndo(() => PutBack(head), description: $"what the modlist repository holds of '{_sourceFolder}'");
        }

        internal override void FinishInit() { }

        private protected override string SourceCommit() => Run("log", "-1", "--format=%H", "HEAD", "--", ".").Trim();
    }

    /// <summary>True exactly when <paramref name="sourceFolder"/> holds the build file, and either a repository of its own
    /// that <see cref="HoldsRepository"/>, or no <c>.git</c> inside a repository whose index holds that build file.</summary>
    internal static bool HoldsSourceMod(string sourceFolder)
    {
        if (!File.Exists(Path.Combine(sourceFolder, SourceRepositoryLayout.BuildFileName))) return false;
        if (HoldsGit(sourceFolder)) return HoldsRepository(sourceFolder);
        return WorkTreeAbove(sourceFolder) is { } workTree && TracksBuildFile(sourceFolder, workTree);
    }

    /// <summary>True exactly when <paramref name="sourceFolder"/> holds a repository whose <c>main</c> exists, or one init
    /// committed nothing in. Any other <c>.git</c> is <see cref="HoldsAnotherRepository"/>.</summary>
    internal static bool HoldsRepository(string sourceFolder)
    {
        var gitDir = GitDirOf(sourceFolder);
        return Directory.Exists(gitDir) && (HasMainBranch(gitDir) || InitFinished(gitDir));
    }

    private static bool HoldsGit(string folder)
    {
        var dotGit = Path.Combine(folder, ".git");
        return Directory.Exists(dotGit) || File.Exists(dotGit);
    }

    // Read off the file system, not by running git: every read of a compiled plugin asks this.
    private static string? WorkTreeAbove(string sourceFolder)
    {
        for (var folder = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(sourceFolder))); folder is not null; folder = Path.GetDirectoryName(folder))
        {
            if (HoldsGit(folder)) return folder;
        }
        return null;
    }

    private static readonly ConcurrentDictionary<string, StampGatedMemo<StrongBox<bool>>> s_tracksBuildFile = new(StringComparer.Ordinal);

    // Every read of a compiled plugin asks this, so git is asked again only once the index file changed.
    private static bool TracksBuildFile(string sourceFolder, string workTree)
    {
        var gitDir = GitDirOf(workTree);
        var folder = Path.GetFullPath(sourceFolder);
        var memo = s_tracksBuildFile.GetOrAdd(folder, _ => new StampGatedMemo<StrongBox<bool>>(TimeProvider.System));
        return memo.Of(Path.Combine(gitDir, "index"), () => new StrongBox<bool>(
            GitCli.TryRun(gitDir, workTree, folder, out var listed, "ls-files", "--", LiteralPathspec(SourceRepositoryLayout.BuildFileName)) && listed.Length > 0))
            ?.Value ?? false;
    }

    internal const string InitMarkSection = "medit";
    internal const string InitMarkKey = "init";
    internal const string InitPending = "pending";
    internal const string InitDone = "done";

    /// <summary>A <c>.git</c> with no <c>main</c> and no init mark: someone else's, which init never
    /// writes to (ADR-0003). The mark is a config key set right after <c>git init</c>.</summary>
    internal static bool HoldsAnotherRepository(string sourceFolder)
    {
        var gitDir = GitDirOf(sourceFolder);
        return Directory.Exists(gitDir) && !HasMainBranch(gitDir) && !IsMarkedByInit(gitDir);
    }

    // A submodule git checks out holds a .git file naming its git directory, as gitrepository-layout(5) has it.
    private static string GitDirOf(string workTree)
    {
        const string GitFile = "gitdir: ";
        var dotGit = Path.Combine(workTree, ".git");
        if (!File.Exists(dotGit)) return dotGit;
        var line = File.ReadLines(dotGit).FirstOrDefault() ?? "";
        return line.StartsWith(GitFile, StringComparison.Ordinal) ? Path.GetFullPath(line[GitFile.Length..].Trim(), workTree) : dotGit;
    }

    // Whether Modbench's init finished here, with a commit or without. Its mark says "pending" until then, so a crashed
    // init's half-made repository is not mistaken for a made one.
    private static bool InitFinished(string gitDir)
    {
        var config = Path.Combine(gitDir, "config");
        if (!File.Exists(config)) return false;
        var inMark = false;
        foreach (var line in File.ReadLines(config).Select(line => line.Trim()))
        {
            if (line.StartsWith('[')) inMark = line == $"[{InitMarkSection}]";
            else if (inMark && line.Replace(" ", "") == $"{InitMarkKey}={InitDone}") return true;
        }
        return false;
    }

    private static bool IsMarkedByInit(string gitDir)
    {
        var config = Path.Combine(gitDir, "config");
        return File.Exists(config) && File.ReadLines(config).Any(line => line.Trim() == $"[{InitMarkSection}]");
    }

    // Read off the ref store's files, not by running git: every read of a compiled plugin asks this.
    // A branch is a loose ref file until git packs it into packed-refs.
    private static bool HasMainBranch(string gitDir) =>
        File.Exists(Path.Combine(gitDir, "refs", "heads", "main")) || PackedRefs(gitDir).Contains("refs/heads/main");

    private static HashSet<string> PackedRefs(string gitDir)
    {
        var packedRefs = Path.Combine(gitDir, "packed-refs");
        return File.Exists(packedRefs)
            ? [.. File.ReadLines(packedRefs).Select(line => line.IndexOf(' ', StringComparison.Ordinal) is var at and >= 0 ? line[(at + 1)..] : null).OfType<string>()]
            : [];
    }

    internal string GitDirectory => _gitDir;

    internal bool Exists => Directory.Exists(_gitDir);

    // Windows refuses to delete the read-only files git writes.
    internal void Delete()
    {
        foreach (var file in Directory.EnumerateFiles(_gitDir, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(_gitDir, recursive: true);
    }

    // Run in the source folder, so a pathspec is relative to it.
    internal string Run(params string[] args) => GitCli.Run(_gitDir, _workTree, _sourceFolder, args);

    internal bool TryRun(out string stdout, params string[] args) => GitCli.TryRun(_gitDir, _workTree, _sourceFolder, out stdout, args);

    /// <summary>The commit at HEAD, or null before the first commit of an init that committed nothing.</summary>
    internal string? HeadCommit()
    {
        if (TryRun(out var head, "rev-parse", "--verify", "--quiet", "HEAD")) return head.Trim();
        if (TryRun(out var branch, "symbolic-ref", "--quiet", "HEAD") && !RefIsStored(branch.Trim())) return null;
        throw SourceStopException.GitFailed($"git cannot read HEAD of '{_sourceFolder}'");
    }

    // A loose ref is a file, until git packs it into packed-refs.
    private bool RefIsStored(string gitRef) =>
        File.Exists(Path.Combine(_gitDir, gitRef)) || PackedRefs(_gitDir).Contains(gitRef);

    /// <summary>HEAD and the index of the source folder's paths back at <paramref name="head"/>; with none, the branch is
    /// unborn again and the index holds none of them. What else is staged stays staged.</summary>
    internal void PutBack(string? head)
    {
        if (head is null)
        {
            DropBranchAtHead();
            Run("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".");
            return;
        }
        Run("reset", "-q", "--soft", head);
        Run("reset", "-q", head, "--", ".");
    }

    /// <summary>Before the first commit there is no commit to go back to: the branch HEAD names is dropped.</summary>
    internal void DropBranchAtHead()
    {
        if (TryRun(out var branch, "symbolic-ref", "-q", "HEAD") && CommitOf(branch.Trim()) is not null) Run("update-ref", "-d", branch.Trim());
    }

    internal bool HoldsUncommittedChanges() => Run("status", "--porcelain", "--untracked-files=all", "--", ".").Length > 0;

    /// <summary>Whether <paramref name="remote"/>, as last fetched, holds the commit a clone builds the source folder from:
    /// HEAD of its own repository, which the modlist repository pins, or the last commit touching it in the modlist repository.</summary>
    internal bool RemoteHoldsTheSource(string remote)
    {
        if (HeadCommit() is null) return true;
        var source = SourceCommit();
        return source.Length == 0 || Run("for-each-ref", "--contains", source, "--format=%(refname)", $"refs/remotes/{remote}/").Length > 0;
    }

    // git speaks forward slashes on every platform, Windows included, while the layout builds
    // its paths with Path.Combine.
    internal static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    // Plugin and asset file names carry brackets and asterisks, which git otherwise reads as a glob.
    internal static string LiteralPathspec(string relativePath) => $":(literal){ToGitPath(relativePath)}";

    /// <summary>One file's text at the last commit, or null. cat-file -p, not git show: for
    /// a missing glob-shaped path, show exits 0 with empty output — a lying empty string.</summary>
    internal string? ReadCommittedSourceText(string relativePath)
    {
        if (!HoldsSourceMod(_sourceFolder)) return null;

        return TryRun(out var stdout, "cat-file", "-p", $"HEAD:./{ToGitPath(relativePath)}") ? stdout : null;
    }

    /// <summary>Each path in the source folder under the plugin's tree that git status names, with its index-column code;
    /// null when git cannot say. It names both ends of a move and every untracked or ignored file.</summary>
    internal IReadOnlyList<(char Code, string Path)>? WorkingTreeStatus(string pluginFileName)
    {
        if (!TryRun(out var stdout,
                "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored",
                "--", LiteralPathspec(SourceRepositoryLayout.RootFor(pluginFileName))))
        {
            return null;
        }

        var entries = new List<(char, string)>();
        foreach (var entry in stdout.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            // "XY path", the path from the work tree's root: a shorter entry, or one outside the source folder, is one
            // this parse cannot read.
            if (entry.Length < 4 || !entry[3..].StartsWith(SourceFolderInWorkTree, StringComparison.Ordinal)) return null;
            entries.Add((entry[0], entry[(3 + SourceFolderInWorkTree.Length)..]));
        }
        return entries;
    }

    internal IReadOnlyList<string> LastWrittenBinarySha256s(string pluginFileName)
    {
        if (!HoldsSourceMod(_sourceFolder)) return [];

        if (!TryRun(out var body, "log", "-1", "--format=%B", LastCompileRef(pluginFileName)))
            return [];

        return [.. ReadTrailers(body, BinaryTrailer), .. ReadTrailers(body, EarlierBinaryTrailer)];
    }

    internal bool WriteBinary(string pluginFileName, string binarySha256, Action write)
    {
        var headSha = HeadCommit();
        var earlier = LastWrittenBinarySha256s(pluginFileName);
        ParkTrailers("Compile", pluginFileName, headSha, [$"{BinaryTrailer}: {binarySha256}",
            .. earlier.Select(sha => $"{EarlierBinaryTrailer}: {sha}")]);

        write();

        // The binary is on disk, so a git failure from here is a record left unfinished, never a
        // write that did not happen. The ref keeps naming the old and the new binary (ADR-0003).
        try
        {
            ParkTrailers("Compile", pluginFileName, headSha, [$"{BinaryTrailer}: {binarySha256}"]);
            return true;
        }
        catch (SourceStopException)
        {
            return false;
        }
    }

    /// <summary>The working tree now answers to this binary, as after a landed compile: the plugin it was decompiled
    /// from, or the malformed plugin it repairs.</summary>
    internal void ParkDecompiled(string pluginFileName, string binarySha256)
    {
        var headSha = HeadCommit();
        ParkTrailers("Decompile", pluginFileName, headSha, [$"{BinaryTrailer}: {binarySha256}"]);
    }

    /// <summary>What Modbench last wrote for <paramref name="from"/> becomes <paramref name="to"/>'s, and
    /// <paramref name="from"/> has none.</summary>
    internal void MoveLastWritten(string from, string to)
    {
        var fromRef = LastCompileRef(from);
        SetRef(LastCompileRef(to), CommitOf(fromRef));
        SetRef(fromRef, null);
    }

    private string? CommitOf(string gitRef) =>
        TryRun(out var sha, "rev-parse", "--verify", "--quiet", gitRef) ? sha.Trim() : null;

    // A ref already as asked is left untouched, so a put-back over a move that never reached it does
    // not need its lock.
    private void SetRef(string gitRef, string? commitSha)
    {
        if (CommitOf(gitRef) == commitSha) return;
        if (commitSha is not null) Run("update-ref", gitRef, commitSha);
        else Run("update-ref", "-d", gitRef);
    }

    // commit-tree is plumbing with no --trailer flag, so the trailer block is hand-written. The
    // subject names the gesture that made the record. Only the trailers are read, so the commit holds
    // git's empty tree.
    private void ParkTrailers(string gesture, string pluginFileName, string? parent, IEnumerable<string> trailers)
    {
        var message = string.Join('\n', [$"{gesture}: {pluginFileName}", "", .. trailers]);
        string[] parentArgs = parent is null ? [] : ["-p", parent];
        Park(pluginFileName, Run(["commit-tree", EmptyTree, .. parentArgs, "-m", message]).Trim());
    }

    // The one place the last-compile ref moves.
    private void Park(string pluginFileName, string commitSha) =>
        Run("update-ref", LastCompileRef(pluginFileName), commitSha);

    private static IEnumerable<string> ReadTrailers(string body, string key)
    {
        var prefix = $"{key}: ";
        return body.Split('\n')
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .Select(line => line[prefix.Length..].Trim());
    }

    // The one place the last-compile ref is built, under the source folder's path, since one repository's source
    // folders can each hold a plugin of one name (ADR-0012). Each component is percent-encoded, which keeps it injective.
    private string LastCompileRef(string plugin)
    {
        // An empty name is an upstream bug: encoding it would yield a ref ending in "/", which git rejects
        // too.
        if (string.IsNullOrEmpty(plugin))
            throw new ArgumentException("Plugin filename must not be empty.", nameof(plugin));

        var folder = string.Concat(SourceFolderInWorkTree.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(segment => $"{EncodeRefComponent(segment)}/"));
        return $"refs/medit/last-compile/{folder}{EncodeRefComponent(plugin)}";
    }

    // Percent-encodes every byte outside ASCII alnum/-/_, plus '.' where a literal one would make a
    // component git rejects (leading, trailing, "..", trailing ".lock"). '%' is always escaped, which
    // keeps this injective.
    private static string EncodeRefComponent(string component)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(component);
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
