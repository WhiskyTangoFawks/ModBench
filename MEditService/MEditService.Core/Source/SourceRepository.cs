namespace MEditService.Core.Source;

/// <summary>
/// ADR-0041's repo-layer verb surface over a mod folder's own git repository. Stateless by
/// construction: tracked *is* the presence of a <c>.git</c> directory inside the mod folder — no
/// registry, nothing cached, nothing to reconcile. Every verb tolerates the folder (or its
/// <c>.git</c>) having changed or vanished since it was last observed — never-assume-exclusive-
/// ownership (root CLAUDE.md): MO2's Replace install shell-deletes a whole mod folder, and nothing
/// here is notified when that happens.
/// </summary>
public static class SourceRepository
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
    /// half-repo <b>and no orphaned files</b>: the catch block removes <c>.git</c>, the
    /// <c>.gitignore</c> written directly into <paramref name="modFolder"/>, and the
    /// <c>pristineFiles</c> tree already written under the one root <c>source/</c> folder, since
    /// all three land in <paramref name="modFolder"/> before the commit that is meant to make them
    /// real (#508 — the original cleanup deleted only <c>.git</c>).
    /// <see cref="SourceRecordPath"/>/<see cref="Serialization.RecordTextCodec"/> already
    /// did the serialization this method just commits, so it never invents record content, and it
    /// never invents provenance content either (comment 1, #414) — <paramref name="trailers"/> is
    /// an input, not computed here.
    ///
    /// Uniform by construction (ADR-0041 amendment, comment 2 on #414): always serializes, always
    /// commits to <c>main</c>, always creates and checks out the edit branch. There is no
    /// Authored/Modified parameter — that distinction is a workflow the user chooses after Track,
    /// never a Track-time mode.
    /// </summary>
    public static void Track(string modFolder, SourcePreset preset, IReadOnlyList<PristineFile> pristineFiles, TrackProvenance trailers)
    {
        GitCli.EnsureOnPath();

        // Refused before touching git at all — not merely "git init happens to fail harmlessly".
        // Reaching the try/cleanup block below against a *real*, already-tracked repo would delete
        // it on the very first failure (checkout -b on an existing branch name, for one), mistaking
        // someone else's repo for this call's own half-init.
        if (IsTracked(modFolder))
            throw new SourceAlreadyTrackedException($"'{modFolder}' is already tracked.");

        var gitDir = Path.Combine(modFolder, ".git");
        try
        {
            GitCli.Run(gitDir, modFolder, "init", "-q", "-b", "main");
            GitCli.Run(gitDir, modFolder, "config", "core.autocrlf", "false");
            GitCli.Run(gitDir, modFolder, "config", "commit.gpgsign", "false");
            // #451: the Spriggit flat layout's own file names routinely carry a space
            // ("<EditorID> - <hex6>_<ModKeyFileName>.json") — git's default quotePath=true C-quotes any
            // path with a space (or non-ASCII byte) in porcelain output, which the pre-#451 flat
            // <recordType>/<originModKey>/<hex6>.json layout never triggered (hex-only path segments).
            // Every porcelain reader in this codebase (WorkingTreeStatus's own -z NUL-separated parse,
            // and every caller of plain `git status --porcelain`) expects the raw path back, not a
            // quoted-and-escaped one — set once, repo-local, at the one place every tracked repo is
            // born, rather than taught to every reader.
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
            // One transaction from the caller's view (comment 1, #414): a failure anywhere above
            // must not leave a half-initialized repo behind for IsTracked to wrongly report as
            // tracked, or for a later Track retry to collide with. #508: `.git` was the only thing
            // ever cleaned up here, orphaning the `.gitignore` written above and any of
            // `pristineFiles`' tree already written under the one root `source/` folder — both land
            // directly in modFolder *before* the commit that is supposed to make them real. Uniform
            // by construction: one catch block covers every step above (init through checkout), so
            // this cleanup runs the same way no matter which line threw.
            if (Directory.Exists(gitDir)) Directory.Delete(gitDir, recursive: true);
            var gitignorePath = Path.Combine(modFolder, ".gitignore");
            if (File.Exists(gitignorePath)) File.Delete(gitignorePath);
            var sourceRoot = Path.Combine(modFolder, SourceRecordPath.RootFolderName);
            if (Directory.Exists(sourceRoot)) Directory.Delete(sourceRoot, recursive: true);
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

    /// <summary>One source file's text as <c>HEAD</c> has it — the content behind a hash
    /// <see cref="CommittedSourceHashes"/> reported. Null when the folder isn't tracked or the path
    /// isn't in the commit (a record created since, or one never committed).
    ///
    /// <para><b>#459: <c>cat-file -p</c>, deliberately not <c>git show</c>.</b> <c>git show
    /// &lt;rev&gt;:&lt;path&gt;</c> treats a <b>missing</b> path as a pathspec and applies glob magic to
    /// it — verified empirically against git 2.43: for a path containing <c>[</c>/<c>]</c> (exactly
    /// what a folder-split child's <c>"[N] "</c> ordering prefix puts there) that does not exist at
    /// <paramref name="modFolder"/>'s <c>HEAD</c>, <c>git show</c> exits <b>0</b> with <b>empty</b>
    /// output instead of failing — a silent "found nothing" masquerading as "found an empty file",
    /// which fed straight into <see cref="Records.DuckDbRecordIndex.SetCommittedBaseline"/> as a
    /// real (empty) baseline body and crashed there on the malformed-JSON insert. <c>git cat-file -p
    /// &lt;rev&gt;:&lt;path&gt;</c> resolves the same object syntax but never applies pathspec
    /// glob-matching to the path half, so a missing bracketed path fails loudly (exit 128) exactly
    /// like a missing unbracketed one always did — restoring the null this method's own contract
    /// promises instead of a lying empty string.</para>
    /// </summary>
    internal static string? ReadCommittedSourceText(string modFolder, string relativePath)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        return GitCli.TryRun(gitDir, modFolder, out var stdout, "cat-file", "-p", $"HEAD:{ToGitPath(relativePath)}")
            ? stdout
            : null;
    }

    /// <summary>
    /// Every source record's text under <c>source/&lt;pluginName&gt;/**</c> as <paramref name="gitRef"/>
    /// has it — no checkout, so a compile at <c>main</c> (#416 S8/<see cref="Edits.CompileSource.AtRef"/>)
    /// never touches the edit branch's own working tree or index, exactly like
    /// <see cref="ReadCommittedSourceText"/>'s no-checkout read but for a whole plugin's tree at any
    /// ref rather than one path at <c>HEAD</c>. Empty (not null) when the folder isn't tracked, the
    /// ref doesn't resolve, or the plugin has no source tree at that ref — an "AtRef" compile target
    /// with nothing to compile is a real, empty answer here, not a failure to report; the caller
    /// decides what an empty source means for a plugin that is supposed to be tracked.
    /// </summary>
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

            // #459: cat-file -p, not show — see ReadCommittedSourceText's own doc comment (this path
            // came from ls-tree so it always exists, but there is no reason to keep the one git
            // subcommand that mishandles a bracketed "[N] "-prefixed path when a safe one is right
            // there).
            if (!GitCli.TryRun(gitDir, modFolder, out var text, "cat-file", "-p", $"{gitRef}:{relativePath}")) continue;
            results.Add((relativePath, System.Text.Encoding.UTF8.GetBytes(text)));
        }
        return results;
    }

    /// <summary>
    /// Re-parks <c>refs/medit/last-compile/&lt;plugin&gt;</c> at a floating snapshot of the tree
    /// <paramref name="source"/> just compiled from — no HEAD, branch, or index movement (the
    /// <c>git stash create</c> idiom, ADR-0041's 2026-08-19 amendment), message carrying a
    /// <c>Binary-SHA256</c> trailer for the binary the caller just finished writing. Track already
    /// initializes this ref to the pristine baseline (#414); every compile after that re-points it
    /// here, and only after the caller confirms the binary write landed — this method never runs
    /// before that, by construction of who calls it (<c>Edits.PluginCompileService</c>).
    ///
    /// <para>The snapshotted tree depends on <paramref name="atRef"/> (deliberately the same two
    /// primitives the compile source itself boils down to, rather than a dependency on
    /// <c>Edits.CompileSource</c> — the repo layer stays the lower one of the two, never the other
    /// way around): null (the normal, working-tree compile) snapshots the actual working directory as
    /// compile read it (<c>git stash create</c>'s own snapshot, degrading to <c>HEAD</c>'s tree when
    /// the working tree is byte-identical to the index — <c>git stash create</c> answers empty then,
    /// and there is nothing dirtier to snapshot); a ref name (compile at that ref, no checkout)
    /// snapshots that ref's own tree directly — no working directory was involved in that compile at
    /// all, so there is nothing to stash. Both land through the same <c>git commit-tree</c> call,
    /// which is what keeps the two cases one code path instead of two.</para>
    /// </summary>
    internal static void ParkCompileSnapshot(
        string modFolder, string plugin, string? atRef, string binarySha256)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        var headSha = GitCli.Run(gitDir, modFolder, "rev-parse", "HEAD").Trim();

        var tree = atRef == null
            ? WorkingTreeSnapshotTree(gitDir, modFolder, headSha)
            : GitCli.Run(gitDir, modFolder, "rev-parse", $"{atRef}^{{tree}}").Trim();

        // commit-tree is plumbing: it takes a literal message, not --trailer (that's porcelain's own
        // commit command) — the trailer is git's own "Key: Value" line at the message tail, blank-
        // line-separated, written by hand here for the one caller that needs a trailer on a commit
        // object nothing else in this class builds through `git commit`.
        var message = $"Save & Compile: {plugin}\n\nBinary-SHA256: {binarySha256}";
        var snapshotSha = GitCli.Run(gitDir, modFolder, "commit-tree", tree, "-p", headSha, "-m", message).Trim();
        GitCli.Run(gitDir, modFolder, "update-ref", LastCompileRef(plugin), snapshotSha);
    }

    /// <summary>
    /// #449: whether <paramref name="plugin"/>'s source has moved past what
    /// <c>refs/medit/last-compile/&lt;plugin&gt;</c> parked — "the game can't see your edits yet" —
    /// plus that ref's own commit timestamp for the tooltip that names it. Cheap and bounded by dirt
    /// (the freshness philosophy, <see cref="SourceFreshness"/>): two git calls, both scoped to this
    /// plugin's own <c>source/&lt;plugin&gt;/</c> subtree, neither touching record count or load
    /// order — a <c>git diff</c> between the parked ref and the working tree directly (catches a
    /// tracked file edited since the last compile, whether that edit was ever committed or not — a
    /// compile snapshots the working tree, not <c>HEAD</c>, and commit stays ungated per ADR-0042's
    /// amendment, so "committed but not recompiled" and "edited but neither committed nor recompiled"
    /// are the same question against the ref), plus a <c>git status</c> for a brand-new,
    /// never-<c>git add</c>ed source file, which plain <c>git diff</c> can't see at all —
    /// <c>RecordEditService</c>'s create path writes straight to disk, no staging.
    ///
    /// <para>Never stale for an untracked folder or a plugin with no parked ref at all — a plugin
    /// Track never covered (#288's New-Plugin-into-an-already-tracked-folder gap) degrades safely to
    /// "nothing to compare against" rather than a false positive; the first compile is what parks the
    /// ref and gives this something to answer from then on.</para>
    ///
    /// <para><c>:(literal)</c> pathspec magic on both calls, deliberately — #459's own lesson: a real
    /// plugin filename routinely carries <c>[</c>/<c>]</c>, which git's pathspec glob matching would
    /// otherwise silently misinterpret rather than match literally.</para>
    /// </summary>
    internal static CompileFreshness CompileFreshnessOf(string modFolder, string plugin)
    {
        if (!IsTracked(modFolder)) return new CompileFreshness(false, null);

        var gitDir = Path.Combine(modFolder, ".git");
        var refName = LastCompileRef(plugin);
        if (!GitCli.TryRun(gitDir, modFolder, out _, "rev-parse", "--verify", "--quiet", refName))
            return new CompileFreshness(false, null);

        var lastCompiledAt = LastCompileTimestamp(gitDir, modFolder, refName);
        var sourcePrefix = ToGitPath(SourceRecordPath.RootFor(plugin));
        var pathspec = LiteralPathspec($"{sourcePrefix}/");

        if (HasUntrackedFileUnder(gitDir, modFolder, pathspec))
            return new CompileFreshness(true, lastCompiledAt);

        var unchangedSinceLastCompile = GitCli.TryRun(gitDir, modFolder, out _, "diff", "--quiet", refName, "--", pathspec);
        return new CompileFreshness(!unchangedSinceLastCompile, lastCompiledAt);
    }

    // Plain `git diff <ref>` (no second rev, no --cached) compares the ref's tree against the
    // *working directory* for every path git already has an index entry for — exactly what's wanted
    // here — but a path with no index entry at all (a source file `RecordEditService`'s create path
    // just wrote, never `git add`ed) is invisible to it. `git status` is what sees "??" entries.
    private static bool HasUntrackedFileUnder(string gitDir, string workTree, string pathspec)
    {
        if (!GitCli.TryRun(gitDir, workTree, out var status, "status", "--porcelain=v1", "-z", "--", pathspec))
            return false;
        return status.Split('\0', StringSplitOptions.RemoveEmptyEntries)
            .Any(entry => entry.StartsWith("??", StringComparison.Ordinal));
    }

    // %cI: the committer date in strict ISO-8601, parseable directly by DateTimeOffset.TryParse with
    // no format string of our own to keep in sync with git's.
    private static DateTimeOffset? LastCompileTimestamp(string gitDir, string modFolder, string refName)
    {
        if (!GitCli.TryRun(gitDir, modFolder, out var stdout, "log", "-1", "--format=%cI", refName))
            return null;
        return DateTimeOffset.TryParse(
            stdout.Trim(), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var parsed)
            ? parsed
            : null;
    }

    // #459: ":(literal)" pathspec magic disables fnmatch glob interpretation of the path that
    // follows — without it, a plugin filename carrying '[' or ']' (routine in real FO4 mod names)
    // would be silently misread as a glob character class rather than matched literally.
    private static string LiteralPathspec(string path) => $":(literal){path}";

    // git stash create answers empty (not an error) when the working tree has nothing to stash —
    // byte-identical to the index, which itself matches HEAD absent any porcelain staging this repo
    // never does. There is nothing dirtier to snapshot than HEAD's own tree in that case.
    private static string WorkingTreeSnapshotTree(string gitDir, string workTree, string headSha)
    {
        if (!GitCli.TryRun(gitDir, workTree, out var stashSha, "stash", "create") || string.IsNullOrWhiteSpace(stashSha))
            return GitCli.Run(gitDir, workTree, "rev-parse", $"{headSha}^{{tree}}").Trim();

        return GitCli.Run(gitDir, workTree, "rev-parse", $"{stashSha.Trim()}^{{tree}}").Trim();
    }

    /// <summary>
    /// #417's Absorb Upstream Update: commits <paramref name="pristineFiles"/> onto <c>main</c> as a
    /// new baseline — by plumbing, exactly like <see cref="Track"/>'s own baseline commit, but with
    /// <b>no checkout at all</b>: the edit branch stays checked out throughout, its working tree, its
    /// index and its <c>HEAD</c> all untouched. Fresh <paramref name="trailers"/> replace whatever
    /// main's previous tip carried — <see cref="LatestBaselineTrailers"/> only ever reads the tip, so
    /// nothing needs merging with the old ones. Every parked ref <paramref name="trailers"/> names is
    /// advanced to the new commit too, the same "the parked ref is the detection reference" contract
    /// <see cref="ParkCompileSnapshot"/> established, extended to cover a baseline that arrived with
    /// no compile at all.
    /// </summary>
    public static void CommitPristineToMain(
        string modFolder, IReadOnlyList<PristineFile> pristineFiles, TrackProvenance trailers)
    {
        GitCli.EnsureOnPath();
        var gitDir = Path.Combine(modFolder, ".git");
        var parentSha = GitCli.Run(gitDir, modFolder, "rev-parse", "refs/heads/main").Trim();

        // A scratch working tree and a scratch index — never the mod folder's own, never its real
        // index — is what "no checkout" actually buys: `add`/`write-tree` need *some* work tree and
        // index to operate against, and the edit branch's real ones may themselves hold the user's
        // own staged dirt that this call must never disturb.
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

    /// <summary>
    /// #417's offered rebase — the edit branch replayed onto <c>main</c>'s new tip, offered as a
    /// separate, non-modal step after Absorb Upstream Update lands a baseline, and re-runnable later
    /// via <c>Modbench: Rebase onto Updated Baseline</c>. Refuses over any working-tree dirt (git's
    /// own refusal posture, ADR-0041 amendment: "refuse, and the user fixes it") before ever touching
    /// the branch — commit, stash or discard is the user's own gesture, never automated here.
    ///
    /// <para><b>Resumption-aware</b>: the one command re-running this after a conflict must also be
    /// how the user continues it (there is no separate "continue" gesture surfaced to them — the
    /// native merge editor they resolved conflicts in doesn't know this rebase exists, since it was
    /// never driven through <c>vscode.git</c>'s own porcelain). If git already has a rebase in
    /// progress here (<c>.git/rebase-merge</c> or <c>.git/rebase-apply</c>), the resolved-but-staged
    /// files are not dirt to refuse over — they're the answer — so this delegates straight to
    /// <see cref="ContinueRebase"/> instead of the dirt guard and a fresh <c>rebase</c> invocation,
    /// which would either wrongly refuse (dirt guard) or fail outright (git refuses a second
    /// concurrent rebase).</para>
    /// </summary>
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

    /// <summary>
    /// Continues a rebase left mid-flight by <see cref="RebaseEditBranch"/>'s own conflict outcome,
    /// after the user has hand-resolved the conflicted source file(s) in the native merge editor —
    /// stages whatever the working tree now holds (this repo's tree is source-JSON-only, so a blanket
    /// <c>add -A</c> is exactly "the resolution the user just wrote", nothing more) and continues.
    /// </summary>
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

    /// <summary>
    /// Every relative path <c>git status</c> considers dirty in <paramref name="modFolder"/>'s
    /// working tree — staged or not, matching the file, not the index alone (#417's refuse-over-dirt
    /// checks: rebase-over-dirt and Keep-as-My-Edit's same-record collision both need "does the
    /// user have any uncommitted change here", which a bare index compare would miss for a plain
    /// unstaged edit). Empty when the folder isn't tracked or nothing is dirty — never a failure;
    /// callers treat both the same way, "nothing to refuse over".
    /// </summary>
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

    /// <summary>
    /// The <c>Binary-SHA256</c> trailer off <c>refs/medit/last-compile/&lt;plugin&gt;</c>'s own
    /// commit message — "the binary as Modbench last wrote it" (#417's self-echo tell: a freshly
    /// observed binary whose hash matches this one is Save &amp; Compile's own write, not an
    /// external change). Null when the folder isn't tracked, the ref doesn't exist, or the ref's
    /// commit carries no such trailer — a missing or orphaned ref degrades to asking the dialog's
    /// question, never a throw (comment 1, #417 pinned decisions).
    ///
    /// <para><b>Two trailer shapes share this key, and this method reads both.</b> Before any
    /// compile has ever run, Track already parked this exact ref straight at the shared baseline
    /// commit (#414), whose message carries one <c>Binary-SHA256: &lt;plugin&gt;=&lt;hash&gt;</c>
    /// line <i>per plugin the mod folder holds</i> (<see cref="CommitWithTrailers"/>'s multi-plugin
    /// format). Every compile after that re-parks the ref at its own floating snapshot instead
    /// (<see cref="ParkCompileSnapshot"/>), whose message carries a bare
    /// <c>Binary-SHA256: &lt;hash&gt;</c> — no plugin prefix, because that ref already names one
    /// plugin. Reading only the bare shape would misread every freshly tracked, never-yet-compiled
    /// plugin's own hash as absent and misclassify its own untouched binary as an external change.
    /// </para>
    /// </summary>
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

    /// <summary>
    /// The provenance trailers off <c>main</c>'s own tip commit (<see cref="CommitWithTrailers"/>'s
    /// own format) — <b>explicitly <c>refs/heads/main</c></b>, never bare <c>HEAD</c>: the edit
    /// branch is checked out in normal use, and <c>main</c> is never checked out (ADR-0041), so
    /// reading "the branch git happens to have checked out" would silently answer for the wrong ref
    /// the moment this is called against a real session. <see cref="TrackProvenance.BinarySha256ByPlugin"/>
    /// is per-plugin on one shared commit (a mod folder can hold more than one plugin); everything
    /// else is folder-wide. Null when the folder isn't tracked or <c>main</c> has no commit yet.
    /// </summary>
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

    // Git's own trailer shape: "Key: Value" lines at the message tail, one per line. Returns the
    // last matching line's value (a commit carries at most one in every writer this class has, but
    // "last wins" is the same rule git itself uses for a repeated trailer key).
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

    /// <summary>
    /// #433: the one place <c>refs/medit/last-compile/&lt;plugin&gt;</c> is built — every call site
    /// that reads or writes this ref family goes through here, never a second inline interpolation of
    /// the raw filename. Almost every real Fallout 4 plugin name is ref-unsafe by git's own rules
    /// (spaces, <c>[</c>/<c>]</c>, and more are forbidden — <c>git check-ref-format</c>), so
    /// <see cref="EncodeRefComponent"/> percent-encodes the plugin filename before it ever reaches
    /// git.
    ///
    /// <para><b>The encoding is stable and injective, deliberately not reversible</b> (triage decision
    /// on #433): two distinct plugin filenames must never collapse onto the same ref, but nothing in
    /// this codebase enumerates <c>refs/medit/last-compile/*</c> (no <c>for-each-ref</c>/<c>show-ref</c>
    /// caller exists) — every site starts from a known plugin name and encodes forward. A future
    /// caller that needs to go the other way must not assume this ref suffix decodes back to a literal
    /// filename.</para>
    /// </summary>
    internal static string LastCompileRef(string plugin)
    {
        // A caller passing an empty plugin name is a bug upstream, not a name to accommodate — left
        // unguarded, EncodeRefComponent's identity behavior on an empty string produces
        // "refs/medit/last-compile/" (a ref ending in "/", which git also rejects), and no placeholder
        // string could be substituted without risking a collision with some real plugin name.
        if (string.IsNullOrEmpty(plugin))
            throw new ArgumentException("Plugin filename must not be empty.", nameof(plugin));

        return $"refs/medit/last-compile/{EncodeRefComponent(plugin)}";
    }

    // Percent-encodes (UTF-8, byte-wise) every byte that isn't ASCII alnum/-/_, plus '.' whenever
    // leaving it literal would produce a ref component git itself rejects for reasons beyond the
    // issue's named character list: a leading dot, a trailing dot, a ".." run, or (git's own lock-file
    // convention) a trailing ".lock". '%' itself is always escaped (to "%25"), which is what keeps
    // this injective — the encoded output can never be ambiguous about where an escape sequence
    // starts. Already-safe names (the common case: plain alnum/dot/dash/underscore filenames, and not
    // ending in ".lock") pass through unchanged.
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

    // Every source path lives under one root "source/" folder (SourceRecordPath.RootFolderName,
    // #441 — replacing the old per-plugin "<plugin>.source/" sibling trees); the Edits preset ignores
    // everything except that one folder, Everything additionally un-ignores assets. meta.ini is
    // excluded in both — it is never tracked content (ADR-0041 amendment: "never track a file that
    // changes for non-content reasons") — and plugin binaries (the compiled artifact, never written
    // by this module) are ignored in both.
    private static string GitignoreContent(SourcePreset preset) => preset switch
    {
        // Root-anchored (leading "/"), deliberately, not bare "source/": a bare pattern ignores any
        // path *segment* named "source" at any depth, and a mod's own Papyrus assets legitimately
        // nest a directory of that name below the root (Scripts/Source/*.psc) — an unanchored
        // pattern would swallow those too. The root folder only ever lives at the mod folder's own
        // root (SourceRecordPath.RootFor), so anchoring loses nothing real.
        SourcePreset.Edits =>
            "# Generated by Track (Edits preset) — mEdit never rewrites this file after Track.\n" +
            "*\n" +
            $"!/{SourceRecordPath.RootFolderName}/\n" +
            $"!/{SourceRecordPath.RootFolderName}/**\n" +
            "!.gitignore\n" +
            "meta.ini\n",
        // Root-anchored (leading "/"), deliberately, not bare "*.esp": a bare pattern ignores any
        // path *segment* ending ".esp" at any depth. Plugin binaries only ever live at the mod
        // folder root, so anchoring loses nothing.
        SourcePreset.Everything =>
            "# Generated by Track (Everything preset) — mEdit never rewrites this file after Track.\n" +
            "/*.esp\n" +
            "/*.esm\n" +
            "/*.esl\n" +
            "meta.ini\n",
        _ => throw new ArgumentOutOfRangeException(nameof(preset), preset, "Unknown source preset."),
    };
}

/// <summary>The provenance <c>main</c>'s tip commit carries right now — <see cref="SourceRepository.LatestBaselineTrailers"/>'s
/// read counterpart to <see cref="TrackProvenance"/>, the write side. All optional, same as
/// <see cref="TrackProvenance"/> (authored/manually-installed mods may have none).</summary>
public sealed record BaselineTrailers(string? UpstreamVersion, string? MetaSha256, string? BinarySha256);

/// <summary><see cref="SourceRepository.CompileFreshnessOf"/>'s answer — <see cref="Stale"/> is
/// #449's own signal ("source ahead of binary"), <see cref="LastCompiledAt"/> the parked ref's own
/// commit timestamp for the tooltip that names it. Both null/false together for an untracked folder
/// or a plugin Track never parked a ref for.</summary>
public sealed record CompileFreshness(bool Stale, DateTimeOffset? LastCompiledAt);

/// <summary><see cref="SourceRepository.RebaseEditBranch"/>/<see cref="SourceRepository.ContinueRebase"/>'s
/// outcome. <see cref="ConflictedPaths"/> is the extension's cue to open each path in VS Code's native
/// merge editor; <see cref="RefusalReason"/> is set only for <see cref="RebaseOutcome.Refused"/>.</summary>
public sealed record RebaseResult(RebaseOutcome Outcome, string? RefusalReason, IReadOnlyList<string> ConflictedPaths)
{
    public static RebaseResult Clean() => new(RebaseOutcome.Clean, null, []);

    public static RebaseResult Refused(string reason) => new(RebaseOutcome.Refused, reason, []);

    public static RebaseResult Conflicted(IReadOnlyList<string> conflictedPaths) => new(RebaseOutcome.Conflicted, null, conflictedPaths);
}

/// <summary>The three shapes a rebase attempt can end in — never a fourth, never a thrown exception
/// for the two expected outcomes (refusal, conflict) a caller must render, not crash on.</summary>
public enum RebaseOutcome
{
    /// <summary>The edit branch now sits on top of main's new tip, replayed cleanly.</summary>
    Clean,

    /// <summary>Refused before touching the branch — uncommitted dirt in the working tree.</summary>
    Refused,

    /// <summary>Left mid-rebase with conflict markers in <see cref="RebaseResult.ConflictedPaths"/>;
    /// <see cref="SourceRepository.ContinueRebase"/> is how the user resumes after resolving them.</summary>
    Conflicted,
}

/// <summary>Thrown by <see cref="SourceRepository.Track"/> when the mod folder already has a
/// <c>.git</c> — named and actionable (never a bare <see cref="InvalidOperationException"/> a
/// caller would have to string-match to tell apart from any other one) so the endpoint layer can
/// map it to a real HTTP conflict, distinct from every other failure this call can raise.</summary>
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
