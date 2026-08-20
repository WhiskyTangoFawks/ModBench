namespace MEditService.Core.Ledger;

/// <summary>
/// ADR-0041's repo-layer verb surface over a mod folder's own git repository. Stateless by
/// construction: tracked *is* the presence of a <c>.git</c> directory inside the mod folder — no
/// registry, nothing cached, nothing to reconcile. Every verb tolerates the folder (or its
/// <c>.git</c>) having changed or vanished since it was last observed — never-assume-exclusive-
/// ownership (root CLAUDE.md): MO2's Replace install shell-deletes a whole mod folder, and nothing
/// here is notified when that happens.
/// </summary>
public static class LedgerRepository
{
    /// <summary>True exactly when <paramref name="modFolder"/> contains a <c>.git</c> directory —
    /// nothing broader (a folder that merely exists, or exists but was never tracked, is not
    /// tracked) and nothing narrower (no registry lookup, no cached answer).</summary>
    public static bool IsTracked(string modFolder) => Directory.Exists(Path.Combine(modFolder, ".git"));

    /// <summary>
    /// The Track gesture's git mechanics: init a repo in <paramref name="modFolder"/>, write the
    /// preset's <c>.gitignore</c>, write and commit every <paramref name="pristineFiles"/> entry to
    /// <c>main</c> with <paramref name="trailers"/> as commit trailers, park
    /// <c>refs/medit/last-compile/&lt;plugin&gt;</c> at that same commit for every plugin
    /// <paramref name="trailers"/> names, then create and check out the edit branch. One
    /// transaction from the caller's view — a failure anywhere in this sequence leaves no
    /// half-repo; <see cref="LedgerRecordPath"/>/<see cref="Serialization.RecordTextCodec"/> already
    /// did the serialization this method just commits, so it never invents record content, and it
    /// never invents provenance content either (comment 1, #414) — <paramref name="trailers"/> is
    /// an input, not computed here.
    ///
    /// Uniform by construction (ADR-0041 amendment, comment 2 on #414): always serializes, always
    /// commits to <c>main</c>, always creates and checks out the edit branch. There is no
    /// Authored/Modified parameter — that distinction is a workflow the user chooses after Track,
    /// never a Track-time mode.
    /// </summary>
    public static void Track(string modFolder, LedgerPreset preset, IReadOnlyList<PristineFile> pristineFiles, TrackProvenance trailers)
    {
        GitCli.EnsureOnPath();

        // Refused before touching git at all — not merely "git init happens to fail harmlessly".
        // Reaching the try/cleanup block below against a *real*, already-tracked repo would delete
        // it on the very first failure (checkout -b on an existing branch name, for one), mistaking
        // someone else's repo for this call's own half-init.
        if (IsTracked(modFolder))
            throw new LedgerAlreadyTrackedException($"'{modFolder}' is already tracked.");

        var gitDir = Path.Combine(modFolder, ".git");
        try
        {
            GitCli.Run(gitDir, modFolder, "init", "-q", "-b", "main");
            GitCli.Run(gitDir, modFolder, "config", "core.autocrlf", "false");
            GitCli.Run(gitDir, modFolder, "config", "commit.gpgsign", "false");
            EnsureCommitIdentity(gitDir, modFolder);

            File.WriteAllText(Path.Combine(modFolder, ".gitignore"), GitignoreContent(preset));
            foreach (var file in pristineFiles)
            {
                var fullPath = Path.Combine(modFolder, file.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
                File.WriteAllBytes(fullPath, file.Content);
            }

            GitCli.Run(gitDir, modFolder, "add", "-A");
            CommitWithTrailers(gitDir, modFolder, "Track: pristine baseline", trailers);

            var baselineSha = GitCli.Run(gitDir, modFolder, "rev-parse", "main").Trim();
            foreach (var plugin in trailers.BinarySha256ByPlugin.Keys)
                GitCli.Run(gitDir, modFolder, "update-ref", $"refs/medit/last-compile/{plugin}", baselineSha);

            GitCli.Run(gitDir, modFolder, "checkout", "-q", "-b", EditBranchName);
        }
        catch
        {
            // One transaction from the caller's view (comment 1, #414): a failure anywhere above
            // must not leave a half-initialized repo behind for IsTracked to wrongly report as
            // tracked, or for a later Track retry to collide with.
            if (Directory.Exists(gitDir)) Directory.Delete(gitDir, recursive: true);
            throw;
        }
    }

    /// <summary>
    /// The git object names of <paramref name="relativePaths"/> <b>as <c>HEAD</c> has them</b> —
    /// <c>git ls-tree</c>, one process for the whole batch. Null when the folder isn't tracked (a
    /// typed answer, never a throw: a repo can be destroyed between one read and the next). A path
    /// absent from the result simply isn't in the commit.
    ///
    /// <para><b>This is not working-tree status.</b> It asks what the last commit holds; #417 owns
    /// the question of what the working tree holds against the index (<c>WorkingTreeStatus</c>),
    /// along with <c>CommitPristineToMain</c> and the rebase verbs. The distinction is load-bearing,
    /// not naming hygiene: the two answers diverge after exactly the events this verb exists for — an
    /// external commit, rebase or amend moves <c>HEAD</c> without touching a single file.</para>
    ///
    /// <para>The values are directly comparable to <c>records.content_hash</c> with no conversion:
    /// both are git blob object names (<see cref="GitBlobHash"/>), which is the entire reason that
    /// column stores git's own hash rather than one of our own choosing.</para>
    /// </summary>
    internal static IReadOnlyDictionary<string, string>? CommittedLedgerHashes(
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
        // them, and every ledger path segment comes from a plugin filename.
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

    /// <summary>One ledger file's text as <c>HEAD</c> has it — the content behind a hash
    /// <see cref="CommittedLedgerHashes"/> reported. Null when the folder isn't tracked or the path
    /// isn't in the commit (a record created since, or one never committed).</summary>
    internal static string? ReadCommittedLedgerText(string modFolder, string relativePath)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        return GitCli.TryRun(gitDir, modFolder, out var stdout, "show", $"HEAD:{ToGitPath(relativePath)}")
            ? stdout
            : null;
    }

    // git speaks forward slashes on every platform, Windows included, while LedgerRecordPath builds
    // its paths with Path.Combine.
    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    /// <summary>
    /// Commits whatever is currently staged, with <paramref name="trailers"/> rendered as commit
    /// trailers — the one place trailer *formatting* lives, so #417's <c>CommitPristineToMain</c>
    /// (plumbing update baselines onto <c>main</c> without touching the working tree, comment 1 on
    /// #414) reuses this exact mechanism rather than re-deriving the trailer shape. Still an
    /// internal implementation detail today (comment 1 ruling #4 on #414: no public surface without
    /// a caller) — <see cref="Track"/> is this method's only caller until #417 adds its own.
    /// </summary>
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

    /// <summary>The checked-out branch a tracked Downloaded mod's edits live on (CONTEXT.md's
    /// "Edit branch") — one fixed name, not derived from the mod or plugin, since Track operates on
    /// the whole mod folder and a folder can hold more than one plugin.</summary>
    internal const string EditBranchName = "edit";

    /// <summary>Probes the effective (global/system) git identity once, the same way a fresh
    /// `git commit` would; if either half is unset, pins a repo-local fallback so the baseline
    /// commit never fails for lack of identity — never overwrites a real global identity, and never
    /// touches it, only ever writes into this repo's own local config.</summary>
    private static void EnsureCommitIdentity(string gitDir, string workTree)
    {
        if (!GitCli.TryRun(gitDir, workTree, out _, "config", "--get", "user.name"))
            GitCli.Run(gitDir, workTree, "config", "user.name", "Modbench");
        if (!GitCli.TryRun(gitDir, workTree, out _, "config", "--get", "user.email"))
            GitCli.Run(gitDir, workTree, "config", "user.email", "modbench@localhost");
    }

    // Every ledger path lives under "<plugin>.ledger/" (LedgerRecordPath.LedgerSuffix); the Edits
    // preset ignores everything except those trees, Everything additionally un-ignores assets.
    // meta.ini is excluded in both — it is never tracked content (ADR-0041 amendment: "never track
    // a file that changes for non-content reasons") — and plugin binaries (the compiled artifact,
    // never written by this module) are ignored in both.
    private static string GitignoreContent(LedgerPreset preset) => preset switch
    {
        LedgerPreset.Edits =>
            "# Generated by Track (Edits preset) — mEdit never rewrites this file after Track.\n" +
            "*\n" +
            $"!*{LedgerRecordPath.LedgerSuffix}/\n" +
            $"!*{LedgerRecordPath.LedgerSuffix}/**\n" +
            "!.gitignore\n" +
            "meta.ini\n",
        // Root-anchored (leading "/"), deliberately, not bare "*.esp": a bare pattern ignores any
        // path *segment* ending ".esp" at any depth, and LedgerRecordPath's own layout nests a
        // directory named exactly after the record's origin plugin file
        // (<plugin>.ledger/<type>/<originModKey>/...) — an unanchored pattern silently swallowed
        // that whole ledger subtree the moment the origin plugin's own name ended in .esp/.esm/.esl
        // (caught by LedgerRepositoryTrackGitignoreTests, not assumed). Plugin binaries only ever
        // live at the mod folder root, so anchoring loses nothing.
        LedgerPreset.Everything =>
            "# Generated by Track (Everything preset) — mEdit never rewrites this file after Track.\n" +
            "/*.esp\n" +
            "/*.esm\n" +
            "/*.esl\n" +
            "meta.ini\n",
        _ => throw new ArgumentOutOfRangeException(nameof(preset), preset, "Unknown ledger preset."),
    };
}

/// <summary>Thrown by <see cref="LedgerRepository.Track"/> when the mod folder already has a
/// <c>.git</c> — named and actionable (never a bare <see cref="InvalidOperationException"/> a
/// caller would have to string-match to tell apart from any other one) so the endpoint layer can
/// map it to a real HTTP conflict, distinct from every other failure this call can raise.</summary>
public sealed class LedgerAlreadyTrackedException : Exception
{
    public LedgerAlreadyTrackedException() : base("This mod folder is already tracked.")
    {
    }

    public LedgerAlreadyTrackedException(string message) : base(message)
    {
    }

    public LedgerAlreadyTrackedException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
