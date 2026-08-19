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
