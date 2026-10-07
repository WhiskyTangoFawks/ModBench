namespace MEditService.SourceAdapter;

/// <summary>The git repository under one mod folder (ADR-0007): whether it is tracked, what it
/// committed, and the refs that remember the binary Modbench last wrote. Every verb tolerates the
/// folder having vanished since last observed.</summary>
internal sealed class SourceRepositoryGit(string modFolder)
{
    private const string BinaryTrailer = "Binary-SHA256";
    private const string EarlierBinaryTrailer = "Earlier-Binary-SHA256";
    private const string EmptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    private readonly string _modFolder = modFolder;
    private readonly string _gitDir = Path.Combine(modFolder, ".git");

    /// <summary>True exactly when <paramref name="modFolder"/> holds a repository whose <c>main</c>
    /// exists. A <c>.git</c> with no <c>main</c> is Track's own, half made, or
    /// <see cref="HoldsAnotherRepository"/>.</summary>
    internal static bool IsTracked(string modFolder)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        return Directory.Exists(gitDir) && HasMainBranch(gitDir);
    }

    internal const string TrackMarkSection = "medit";
    internal const string TrackMarkKey = "track";

    /// <summary>A <c>.git</c> with no <c>main</c> and no Track mark: someone else's, which Track never
    /// writes to (ADR-0003). The mark is a config key set right after <c>git init</c>.</summary>
    internal static bool HoldsAnotherRepository(string modFolder)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        return Directory.Exists(gitDir) && !HasMainBranch(gitDir) && !IsMarkedAsTracks(gitDir);
    }

    private static bool IsMarkedAsTracks(string gitDir)
    {
        var config = Path.Combine(gitDir, "config");
        return File.Exists(config) && File.ReadLines(config).Any(line => line.Trim() == $"[{TrackMarkSection}]");
    }

    // Read off the ref store's files, not by running git: every read of a tracked plugin asks this.
    // A branch is a loose ref file until git packs it into packed-refs.
    private static bool HasMainBranch(string gitDir) =>
        File.Exists(Path.Combine(gitDir, "refs", "heads", "main")) || PackedBranches(gitDir).Contains("main");

    private static HashSet<string> PackedBranches(string gitDir)
    {
        const string prefix = " refs/heads/";
        var packedRefs = Path.Combine(gitDir, "packed-refs");
        if (!File.Exists(packedRefs)) return [];
        return [.. File.ReadLines(packedRefs)
            .Select(line => line.IndexOf(prefix, StringComparison.Ordinal) is var at and >= 0 ? line[(at + prefix.Length)..] : null)
            .OfType<string>()];
    }

    internal bool Exists => Directory.Exists(_gitDir);

    // Windows refuses to delete the read-only files git writes.
    internal void Delete()
    {
        foreach (var file in Directory.EnumerateFiles(_gitDir, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(_gitDir, recursive: true);
    }

    internal string Run(params string[] args) => GitCli.Run(_gitDir, _modFolder, args);

    internal bool TryRun(out string stdout, params string[] args) => GitCli.TryRun(_gitDir, _modFolder, out stdout, args);

    // git speaks forward slashes on every platform, Windows included, while the layout builds
    // its paths with Path.Combine.
    internal static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    // Plugin and asset file names carry brackets and asterisks, which git otherwise reads as a glob.
    internal static string LiteralPathspec(string relativePath) => $":(literal){ToGitPath(relativePath)}";

    /// <summary>One file's text at the last commit, or null. cat-file -p, not git show: for
    /// a missing glob-shaped path, show exits 0 with empty output — a lying empty string.</summary>
    internal string? ReadCommittedSourceText(string relativePath)
    {
        if (!IsTracked(_modFolder)) return null;

        return TryRun(out var stdout, "cat-file", "-p", $"HEAD:{ToGitPath(relativePath)}") ? stdout : null;
    }

    /// <summary>Each path under the plugin's tree that git status names, with its index-column code;
    /// null when git cannot say. It names both ends of a move and every untracked or ignored
    /// file.</summary>
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
            // "XY path": a shorter entry is one this parse cannot read.
            if (entry.Length < 4) return null;
            entries.Add((entry[0], entry[3..]));
        }
        return entries;
    }

    // The plugin's committed subtree, path and text, from one ls-tree plus one cat-file per blob.
    // Empty, never null: "nothing at that ref" is an answer here.
    internal IEnumerable<(string RelativePath, string Text)> BlobsAtRef(string pluginName, string gitRef)
    {
        if (!IsTracked(_modFolder)) yield break;

        var sourcePrefix = ToGitPath(SourceRepositoryLayout.RootFor(pluginName));
        if (!TryRun(out var listing, "ls-tree", "-r", "-z", gitRef, "--", $"{sourcePrefix}/"))
            yield break;

        // -z so a path carrying a space or non-ASCII survives verbatim; every source path segment
        // comes from a plugin filename or an EditorID.
        foreach (var entry in listing.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            // "<mode> SP <type> SP <object> TAB <file>"
            var tab = entry.IndexOf('\t', StringComparison.Ordinal);
            if (tab < 0) continue;
            var fields = entry[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 3 || fields[1] != "blob") continue;
            var gitPath = entry[(tab + 1)..];

            // cat-file -p, not show: for a missing glob-shaped path show exits 0 with empty output.
            if (!TryRun(out var text, "cat-file", "-p", $"{gitRef}:{gitPath}")) continue;
            yield return (gitPath.Replace('/', Path.DirectorySeparatorChar), text);
        }
    }

    internal IReadOnlyList<string> LastWrittenBinarySha256s(string pluginFileName)
    {
        if (!IsTracked(_modFolder)) return [];

        if (!TryRun(out var body, "log", "-1", "--format=%B", LastCompileRef(pluginFileName)))
            return [];

        return [.. ReadTrailers(body, BinaryTrailer), .. ReadTrailers(body, EarlierBinaryTrailer)];
    }

    internal bool WriteBinary(string pluginFileName, string binarySha256, Action write)
    {
        var headSha = Run("rev-parse", "HEAD").Trim();
        var earlier = LastWrittenBinarySha256s(pluginFileName);
        ParkTrailers("Compile", pluginFileName, headSha, [$"{BinaryTrailer}: {binarySha256}",
            .. earlier.Select(sha => $"{EarlierBinaryTrailer}: {sha}")]);

        write();

        // The binary is on disk, so a git failure from here is a record left unfinished, never a
        // write that did not happen. The ref keeps naming the old and the new binary (ADR-0003).
        try
        {
            var parked = LastCompileRef(pluginFileName);
            var parent = Run("rev-parse", $"{parked}^").Trim();
            ParkTrailers("Compile", pluginFileName, parent, [$"{BinaryTrailer}: {binarySha256}"]);
            return true;
        }
        catch (GitCommandFailedException)
        {
            return false;
        }
    }

    /// <summary>What the working tree now holds was made from this binary, as a landed compile's is.</summary>
    internal void ParkDecompiled(string pluginFileName, string binarySha256)
    {
        var headSha = Run("rev-parse", "HEAD").Trim();
        ParkTrailers("Decompile", pluginFileName, headSha, [$"{BinaryTrailer}: {binarySha256}"]);
    }

    /// <summary>The act that puts what Modbench last wrote for both names back as it stands now, however
    /// much of a move ran since.</summary>
    internal Action LastWrittenPutBack(string from, string to)
    {
        var (fromRef, toRef) = (LastCompileRef(from), LastCompileRef(to));
        var (held, replaced) = (CommitOf(fromRef), CommitOf(toRef));
        return () =>
        {
            SetRef(fromRef, held);
            SetRef(toRef, replaced);
        };
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
    private void ParkTrailers(string gesture, string pluginFileName, string parent, IEnumerable<string> trailers)
    {
        var message = string.Join('\n', [$"{gesture}: {pluginFileName}", "", .. trailers]);
        Park(pluginFileName, Run("commit-tree", EmptyTree, "-p", parent, "-m", message).Trim());
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

    // The one place refs/medit/last-compile/<plugin> is built. Almost every real plugin name is
    // ref-unsafe, so the filename is percent-encoded, which keeps it injective.
    private static string LastCompileRef(string plugin)
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
