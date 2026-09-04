using System.Text.Json.Serialization;

namespace MEditService.Core.Source;

/// <summary>ADR-0041's verb surface over a mod folder's git repository. Stateless: tracked is the
/// presence of .git, and every verb tolerates the folder having vanished since last observed —
/// MO2's Replace install shell-deletes mod folders.</summary>
public static class SourceRepository
{
    /// <summary>True exactly when <paramref name="modFolder"/> contains a <c>.git</c> directory —
    /// nothing broader (a folder that merely exists, or exists but was never tracked, is not
    /// tracked) and nothing narrower (no registry lookup, no cached answer).</summary>
    public static bool IsTracked(string modFolder) => Directory.Exists(Path.Combine(modFolder, ".git"));

    /// <summary>Track's git mechanics: init, .gitignore, commit the baseline to main with trailers, park
    /// every plugin's last-compile ref there, check out the edit branch. One transaction: a failure
    /// removes .git, the .gitignore and the source tree.</summary>
    public static void Track(string modFolder, SourcePreset preset, IReadOnlyList<PristineFile> pristineFiles, TrackProvenance trailers)
    {
        GitCli.EnsureOnPath();

        // Refused before touching git: the cleanup below would delete a real, already-tracked repo on its
        // first failure.
        if (IsTracked(modFolder))
            throw new SourceAlreadyTrackedException($"'{modFolder}' is already tracked.");

        var gitDir = Path.Combine(modFolder, ".git");
        try
        {
            GitCli.Run(gitDir, modFolder, "init", "-q", "-b", "main");
            GitCli.Run(gitDir, modFolder, "config", "core.autocrlf", "false");
            GitCli.Run(gitDir, modFolder, "config", "commit.gpgsign", "false");
            // Flat file names routinely carry a space; git's default quotePath=true C-quotes such paths in
            // porcelain output, and every porcelain reader here expects the raw path. Set once where every
            // repo is born.
            GitCli.Run(gitDir, modFolder, "config", "core.quotePath", "false");
            EnsureCommitIdentity(gitDir, modFolder);

            File.WriteAllText(Path.Combine(modFolder, ".gitignore"), GitignoreContent(preset));
            PristineFileWriter.WriteAll(pristineFiles, modFolder);

            GitCli.Run(gitDir, modFolder, "add", "-A");
            CommitWithTrailers(gitDir, modFolder, "Track: pristine baseline", trailers);

            var baselineSha = GitCli.Run(gitDir, modFolder, "rev-parse", "main").Trim();
            foreach (var plugin in trailers.BinarySha256ByPlugin.Keys)
                GitCli.Run(gitDir, modFolder, "update-ref", LastCompileRef(plugin), baselineSha);

            GitCli.Run(gitDir, modFolder, "checkout", "-q", "-b", EditBranchName);
        }
        catch
        {
            // Cleaning up .git alone would orphan the .gitignore and the source tree, both written before the
            // commit that makes them real.
            if (Directory.Exists(gitDir)) Directory.Delete(gitDir, recursive: true);
            var gitignorePath = Path.Combine(modFolder, ".gitignore");
            if (File.Exists(gitignorePath)) File.Delete(gitignorePath);
            var sourceRoot = Path.Combine(modFolder, SourceRecordPath.RootFolderName);
            if (Directory.Exists(sourceRoot)) Directory.Delete(sourceRoot, recursive: true);
            throw;
        }
    }

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

    /// <summary>The plugin's tree as <paramref name="gitRef"/> has it, with no checkout, so a compile at
    /// main never touches the edit branch's working tree. Empty, not null, when there is nothing at
    /// that ref.</summary>
    internal static IReadOnlyList<(string RelativePath, byte[] Bytes)> EnumerateSourceAtRef(
        string modFolder, string pluginName, string gitRef)
    {
        if (!IsTracked(modFolder)) return [];

        var gitDir = Path.Combine(modFolder, ".git");
        var sourcePrefix = ToGitPath(SourceRecordPath.RootFor(pluginName));
        if (!GitCli.TryRun(gitDir, modFolder, out var lsTreeOutput, "ls-tree", "-r", "-z", gitRef, "--", $"{sourcePrefix}/"))
            return [];

        var results = new List<(string RelativePath, byte[] Bytes)>();
        foreach (var entry in lsTreeOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            var tab = entry.IndexOf('\t', StringComparison.Ordinal);
            if (tab < 0) continue;
            var fields = entry[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 3 || fields[1] != "blob") continue;
            var relativePath = entry[(tab + 1)..];

            // cat-file -p, not show — see ReadCommittedSourceText.
            if (!GitCli.TryRun(gitDir, modFolder, out var text, "cat-file", "-p", $"{gitRef}:{relativePath}")) continue;
            results.Add((relativePath, System.Text.Encoding.UTF8.GetBytes(text)));
        }
        return results;
    }

    /// <summary>Re-parks the last-compile ref at the tree just compiled from, without moving HEAD, branch
    /// or index (ADR-0041). Null <paramref name="atRef"/> snapshots the working tree; a ref name
    /// snapshots that ref's tree.</summary>
    internal static void ParkCompileSnapshot(
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

    /// <summary>Absorb's git mechanics: commits the baseline to main by plumbing with no checkout, so the
    /// edit branch's working tree, index and HEAD stay untouched. Every parked ref named is advanced
    /// too.</summary>
    public static void CommitPristineToMain(
        string modFolder, IReadOnlyList<PristineFile> pristineFiles, TrackProvenance trailers)
    {
        GitCli.EnsureOnPath();
        var gitDir = Path.Combine(modFolder, ".git");
        var parentSha = GitCli.Run(gitDir, modFolder, "rev-parse", "refs/heads/main").Trim();

        // A scratch work tree and index: add/write-tree need some, and the edit branch's real ones may hold
        // the user's own staged dirt.
        var scratchDir = Directory.CreateTempSubdirectory("medit-absorb-").FullName;
        var scratchIndex = Path.Combine(Path.GetTempPath(), $"medit-absorb-index-{Guid.NewGuid():N}");
        try
        {
            PristineFileWriter.WriteAll(pristineFiles, scratchDir);

            GitCli.RunWithIndex(gitDir, scratchDir, scratchIndex, "add", "-A");
            var treeSha = GitCli.RunWithIndex(gitDir, scratchDir, scratchIndex, "write-tree").Trim();

            // commit-tree is plumbing, same posture as ParkCompileSnapshot's own message: no
            // `--trailer` (porcelain-only), the trailer block hand-written at the message tail.
            var message = "Absorb Upstream Update: new pristine baseline\n\n" + FormatTrailers(trailers);
            var commitSha = GitCli.Run(gitDir, modFolder, "commit-tree", treeSha, "-p", parentSha, "-m", message).Trim();

            GitCli.Run(gitDir, modFolder, "update-ref", "refs/heads/main", commitSha);
            foreach (var plugin in trailers.BinarySha256ByPlugin.Keys)
                GitCli.Run(gitDir, modFolder, "update-ref", LastCompileRef(plugin), commitSha);
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
            if (File.Exists(scratchIndex)) File.Delete(scratchIndex);
        }
    }

    // The same "Key: Value" shape CommitWithTrailers produces via `git commit --trailer` (porcelain),
    // hand-written here because commit-tree (plumbing) has no --trailer flag of its own.
    private static string FormatTrailers(TrackProvenance trailers)
    {
        var lines = new List<string>();
        if (trailers.UpstreamVersion is { } upstreamVersion) lines.Add($"Upstream-Version: {upstreamVersion}");
        if (trailers.MetaSha256 is { } metaSha256) lines.Add($"Meta-SHA256: {metaSha256}");
        foreach (var (plugin, sha256) in trailers.BinarySha256ByPlugin.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            lines.Add($"Binary-SHA256: {plugin}={sha256}");
        return string.Join('\n', lines);
    }

    /// <summary>The edit branch replayed onto main's new tip. Refuses over working-tree dirt (ADR-0041).
    /// Mid-rebase, the staged resolutions are the answer, not dirt, so this delegates to
    /// <see cref="ContinueRebase"/>.</summary>
    public static RebaseResult RebaseEditBranch(string modFolder)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        if (RebaseInProgress(gitDir))
            return ContinueRebase(modFolder);

        var dirty = WorkingTreeStatus(modFolder);
        if (dirty.Count > 0)
        {
            return RebaseResult.Refused(
                $"Cannot rebase: uncommitted changes in {string.Join(", ", dirty)}. " +
                "Commit, stash, or discard them first, then try again.");
        }

        // -c core.editor=true: a clean, non-conflicted rebase never needs a message editor, but this
        // keeps the call non-interactive regardless — nothing here has a terminal to hand one to.
        if (GitCli.TryRun(gitDir, modFolder, out _, "-c", "core.editor=true", "rebase", "refs/heads/main"))
            return RebaseResult.Clean();

        return RebaseResult.Conflicted(ConflictedPaths(gitDir, modFolder));
    }

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

    /// <summary>Every path git status considers dirty, staged or not: the refuse-over-dirt checks need
    /// "any uncommitted change here", which an index-only compare would miss. Empty when untracked
    /// or clean.</summary>
    internal static IReadOnlyList<string> WorkingTreeStatus(string modFolder)
    {
        if (!IsTracked(modFolder)) return [];

        var gitDir = Path.Combine(modFolder, ".git");
        if (!GitCli.TryRun(gitDir, modFolder, out var stdout, "status", "--porcelain=v1", "-z")) return [];

        var paths = new List<string>();
        var tokens = stdout.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        var i = 0;
        while (i < tokens.Length)
        {
            var entry = tokens[i];
            i++;
            if (entry.Length < 4) continue;
            paths.Add(entry[3..]);
            // A rename/copy status ("R "/"C ") carries the old path as a second, separately
            // NUL-terminated token with no "XY " prefix of its own — skip it rather than misreading
            // it as an unrelated status line.
            if (entry[0] is 'R' or 'C') i++;
        }
        return paths;
    }

    /// <summary>The Binary-SHA256 trailer off the plugin's last-compile ref. Two shapes: the shared
    /// baseline's per-plugin plugin=hash lines, and a compile snapshot's bare hash. Null degrades to
    /// asking the dialog.</summary>
    internal static string? ParkedCompileBinarySha256(string modFolder, string plugin)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        if (!GitCli.TryRun(gitDir, modFolder, out var body, "log", "-1", "--format=%B", LastCompileRef(plugin)))
            return null;

        const string prefix = "Binary-SHA256: ";
        var values = body.Split('\n')
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .Select(line => line[prefix.Length..].Trim())
            .ToList();

        var pluginSpecific = values
            .Select(value => (Value: value, Separator: value.IndexOf('=')))
            .Where(t => t.Separator >= 0 && t.Value[..t.Separator].Equals(plugin, StringComparison.OrdinalIgnoreCase))
            .Select(t => t.Value[(t.Separator + 1)..])
            .LastOrDefault();
        if (pluginSpecific != null) return pluginSpecific;

        return values.FirstOrDefault(value => !value.Contains('=', StringComparison.Ordinal));
    }

    /// <summary>The trailers off main's tip — explicitly refs/heads/main, never HEAD, since the edit
    /// branch is what is checked out (ADR-0041). Per-plugin for the binary hash; folder-wide otherwise.
    /// Null when untracked.</summary>
    internal static BaselineTrailers? LatestBaselineTrailers(string modFolder, string plugin)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        if (!GitCli.TryRun(gitDir, modFolder, out var body, "log", "-1", "--format=%B", "refs/heads/main"))
            return null;

        const string binaryPrefix = "Binary-SHA256: ";
        var binarySha256 = body.Split('\n')
            .Where(line => line.StartsWith(binaryPrefix, StringComparison.Ordinal))
            .Select(line => line[binaryPrefix.Length..].Trim())
            .Select(value => (Plugin: value.Split('=', 2)[0], Hash: value.Contains('=', StringComparison.Ordinal) ? value.Split('=', 2)[1] : null))
            .Where(pair => pair.Plugin.Equals(plugin, StringComparison.OrdinalIgnoreCase))
            .Select(pair => pair.Hash)
            .LastOrDefault();

        return new BaselineTrailers(ReadTrailer(body, "Upstream-Version"), ReadTrailer(body, "Meta-SHA256"), binarySha256);
    }

    // Last matching line wins — git's own rule for a repeated trailer key.
    private static string? ReadTrailer(string body, string key)
    {
        var prefix = $"{key}: ";
        return body.Split('\n')
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .Select(line => line[prefix.Length..].Trim())
            .LastOrDefault();
    }

    // git speaks forward slashes on every platform, Windows included, while SourceRecordPath builds
    // its paths with Path.Combine.
    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    /// <summary>The one place <c>refs/medit/last-compile/&lt;plugin&gt;</c> is built. Almost every real
    /// plugin name is ref-unsafe, so the filename is percent-encoded: injective, but deliberately not
    /// reversible — nothing enumerates these refs.</summary>
    internal static string LastCompileRef(string plugin)
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

    // Trailer formatting for a real checkout-and-commit; CommitPristineToMain hand-writes the same shape
    // because commit-tree has no --trailer.
    private static void CommitWithTrailers(string gitDir, string workTree, string message, TrackProvenance trailers)
    {
        var commitArgs = new List<string> { "commit", "-q", "-m", message };
        if (trailers.UpstreamVersion is { } upstreamVersion)
            commitArgs.AddRange(["--trailer", $"Upstream-Version={upstreamVersion}"]);
        if (trailers.MetaSha256 is { } metaSha256)
            commitArgs.AddRange(["--trailer", $"Meta-SHA256={metaSha256}"]);
        foreach (var (plugin, sha256) in trailers.BinarySha256ByPlugin.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            commitArgs.AddRange(["--trailer", $"Binary-SHA256={plugin}={sha256}"]);
        GitCli.Run(gitDir, workTree, [.. commitArgs]);
    }

    /// <summary>The checked-out branch edits live on (CONTEXT.md's "Edit branch") — one fixed name, since
    /// a mod folder can hold more than one plugin.</summary>
    internal const string EditBranchName = "edit";

    // Pins a repo-local identity only when the global one is unset; never overwrites a real identity.
    private static void EnsureCommitIdentity(string gitDir, string workTree)
    {
        if (!GitCli.TryRun(gitDir, workTree, out _, "config", "--get", "user.name"))
            GitCli.Run(gitDir, workTree, "config", "user.name", "Modbench");
        if (!GitCli.TryRun(gitDir, workTree, out _, "config", "--get", "user.email"))
            GitCli.Run(gitDir, workTree, "config", "user.email", "modbench@localhost");
    }

    // meta.ini is never tracked content (ADR-0041 amendment) and plugin binaries are the compiled
    // artifact; both are ignored in every preset.
    private static string GitignoreContent(SourcePreset preset) => preset switch
    {
        // Root-anchored: a bare "source/" would also swallow a mod's own Scripts/Source/*.psc.
        SourcePreset.Edits =>
            "# Generated by Track (Edits preset) — mEdit never rewrites this file after Track.\n" +
            "*\n" +
            $"!/{SourceRecordPath.RootFolderName}/\n" +
            $"!/{SourceRecordPath.RootFolderName}/**\n" +
            "!.gitignore\n" +
            "meta.ini\n",
        // Root-anchored: plugin binaries only ever live at the mod folder root.
        SourcePreset.Everything =>
            "# Generated by Track (Everything preset) — mEdit never rewrites this file after Track.\n" +
            "/*.esp\n" +
            "/*.esm\n" +
            "/*.esl\n" +
            "meta.ini\n",
        _ => throw new ArgumentOutOfRangeException(nameof(preset), preset, "Unknown source preset."),
    };
}

/// <summary>The provenance main's tip carries right now, the read counterpart of
/// <see cref="TrackProvenance"/>. All optional.</summary>
public sealed record BaselineTrailers(string? UpstreamVersion, string? MetaSha256, string? BinarySha256);

/// <summary>A rebase attempt's outcome. <see cref="ConflictedPaths"/> is the extension's cue to open
/// each path in the native merge editor; the refusal reason is set only when refused.</summary>
public sealed record RebaseResult(RebaseOutcome Outcome, string? RefusalReason, IReadOnlyList<string> ConflictedPaths)
{
    public static RebaseResult Clean() => new(RebaseOutcome.Clean, null, []);

    public static RebaseResult Refused(string reason) => new(RebaseOutcome.Refused, reason, []);

    public static RebaseResult Conflicted(IReadOnlyList<string> conflictedPaths) => new(RebaseOutcome.Conflicted, null, conflictedPaths);
}

/// <summary>The three shapes a rebase attempt can end in — never a fourth, never a thrown exception
/// for the two expected outcomes (refusal, conflict) a caller must render, not crash on.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RebaseOutcome
{
    /// <summary>The edit branch now sits on top of main's new tip, replayed cleanly.</summary>
    Clean,

    /// <summary>Refused before touching the branch — uncommitted dirt in the working tree.</summary>
    Refused,

    /// <summary>Left mid-rebase with conflict markers in the conflicted paths; continuing is how the user
    /// resumes after resolving them.</summary>
    Conflicted,
}

/// <summary>Thrown by Track when the mod folder already has a <c>.git</c> — named so the endpoint
/// layer maps it to a real HTTP conflict.</summary>
public sealed class SourceAlreadyTrackedException : Exception
{
    public SourceAlreadyTrackedException() : base("This mod folder is already tracked.")
    {
    }

    public SourceAlreadyTrackedException(string message) : base(message)
    {
    }

    public SourceAlreadyTrackedException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
