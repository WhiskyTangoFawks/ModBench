using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Ledger;

/// <summary>
/// Owns one hidden per-origin git repo (ADR-0040): gitdir under <see cref="LedgerOptions.RootPath"/>,
/// working tree = the origin folder (the folder Mod Management's <c>origin</c> — see
/// <c>PluginOrigin</c>/<c>ResolveOrigin()</c> — resolves to a physical path), no <c>.git</c> inside
/// it. One repo per origin folder — keyed by the folder's own canonical absolute path, not by the
/// opaque <c>origin</c> string itself (which Editing must treat as uninterpreted and isn't
/// guaranteed filename-safe) — reused across every record vendored from that origin, created once
/// (<see cref="EnsureRepo"/> is idempotent).
///
/// Committing goes through one door (#393): <see cref="BeginAttemptAsync"/> returns a
/// <see cref="CommitAttempt"/> scope that owns the whole staging protocol — the per-origin gate,
/// a known-clean index before the attempt's first <see cref="CommitAttempt.Stage"/> (review
/// finding, #371: a stray entry a crashed earlier attempt left in the index would otherwise be
/// swept silently into whichever commit against this origin folder happens next), and
/// unstage-on-abandonment when the risky work between stage and commit throws. Staging and
/// committing stay separate operations underneath, not one atomic "commit this text" call,
/// because the split is what the protocol's guarantee is made of: a bare <c>git commit</c>
/// commits whatever is in the <i>index</i> — not whatever the working-tree file currently holds —
/// so a caller stages a path's content immediately after writing it, does the work that can still
/// fail (which may overwrite the working-tree file), and commits knowing the commit still carries
/// what was staged earlier. A failure in between leaves nothing committed and, once the scope's
/// dispose runs, nothing staged either.
///
/// Two callers share the scope (#371/#393): <c>RecordVendor</c> stages a freshly-written pristine
/// blob before applying the risky field edits on top of it; <c>Ledger/LedgerGroupCommitter</c>
/// stages one or more already-tracked records' current dirt (written by <c>RecordVendor</c> on
/// every prior stage, per ADR-0040) right before a save's own commit. One protocol object, reused
/// for both — never two parallel choreographies. The raw primitives
/// (<see cref="StagePath"/>/<see cref="CommitStaged"/>/<see cref="UnstagePath"/>/
/// <see cref="ResetIndexToHead"/>/<see cref="EnsureRepo"/>) are <c>internal</c>: production code
/// cannot sequence them by hand; tests reach them directly for fixture setup, the same
/// <c>InternalsVisibleTo</c> discipline <see cref="GitCli"/> already uses.
///
/// <b>Cross-repo atomicity (#372).</b> A change group spanning several origin folders used to produce
/// one independent, non-atomic commit per origin with no coordination between them — a real,
/// bounded inconsistency window if one origin's commit failed after another's had already succeeded.
/// That window is closed by a journal, not by making git itself transactional across repos (it
/// isn't): <see cref="LedgerGroupCommitter"/> stages every touched origin and records each one's
/// <see cref="JournalEntry"/> — <see cref="WriteTree"/>'s content hash, the exact tree the pending
/// commit will produce — before advancing (committing) any of them, via <see cref="WriteJournal"/>.
/// <see cref="Recover"/>, run once at startup, replays whatever journal a prior process left behind:
/// a repo whose <c>HEAD</c> already matches its journaled hash advanced before the crash; one whose
/// staged index still matches was interrupted before its own commit ran and is completed directly;
/// one that matches neither refuses loudly rather than guessing. A live (non-crashed) failure never
/// leaves a journal behind — the entry is removed the moment this process gives up on it, precisely
/// because only a genuine crash leaves the on-disk index in the state the journal describes.
/// </summary>
public sealed class LedgerRepository(LedgerOptions options, ILogger<LedgerRepository> logger)
{
    /// <summary>Opens the staging protocol as one object (#393): everything a committing caller
    /// used to sequence by hand across five primitives, owned by the returned scope instead.</summary>
    public async Task<CommitAttempt> BeginAttemptAsync(string originFolder, CancellationToken cancel = default)
    {
        var gate = GateFor(originFolder);
        await gate.WaitAsync(cancel).ConfigureAwait(false);
        return new CommitAttempt(this, originFolder, gate, logger);
    }

    // Per-origin-folder mutex (#370 review finding 4, folded in from the former LedgerOriginGate
    // for #393 — the attempt scope is its only user now): git's own index.lock makes two concurrent
    // add/commit sequences against the same gitdir race (one throws), and EnsureRepo's
    // check-then-create has no lock of its own either. Keyed by the folder's canonical path, same
    // normalization PathsFor applies. Deliberately not a general locking abstraction — just enough
    // to serialize the one shared resource (the gitdir).
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> Gates =
        new(StringComparer.Ordinal);

    private static SemaphoreSlim GateFor(string originFolder) =>
        Gates.GetOrAdd(Path.GetFullPath(originFolder), static _ => new SemaphoreSlim(1, 1));

    /// <summary>One committing attempt against one origin folder's ledger repo.</summary>
    public sealed class CommitAttempt : IDisposable
    {
        private readonly LedgerRepository repository;
        private readonly string originFolder;
        private readonly SemaphoreSlim gate;
        private readonly ILogger logger;
        private readonly List<string> stagedPaths = [];

        internal CommitAttempt(LedgerRepository repository, string originFolder, SemaphoreSlim gate, ILogger logger)
        {
            this.repository = repository;
            this.originFolder = originFolder;
            this.gate = gate;
            this.logger = logger;
        }

        /// <summary>The origin folder this attempt is scoped to — exposed so helpers a caller
        /// splits its work into can take the attempt alone instead of the attempt and the folder
        /// travelling as a pair.</summary>
        public string OriginFolder => originFolder;

        public void EnsureRepo() => repository.EnsureRepo(originFolder);

        /// <summary>See <see cref="LedgerRepository.IsTrackedAtHead"/> — same read, scoped to this
        /// attempt's origin folder, so the stage-or-skip decision every committing caller makes
        /// goes through the same door as the staging itself.</summary>
        public bool IsTrackedAtHead(string relativePath) => repository.IsTrackedAtHead(originFolder, relativePath);

        private bool indexReset;

        /// <summary>The first <see cref="Stage"/> of an attempt resets the index to <c>HEAD</c>
        /// first (see <see cref="ResetIndexToHead"/>'s remarks) — lazily, not at
        /// <see cref="LedgerRepository.BeginAttemptAsync"/>, because an attempt may legitimately
        /// open against an origin folder whose repo does not exist yet (and, if it stages nothing,
        /// must never create one — <c>LedgerGroupCommitter</c>'s conditional
        /// <see cref="EnsureRepo"/>). An attempt that never stages never touches the index at
        /// all.</summary>
        public void Stage(string relativePath)
        {
            if (!indexReset)
            {
                repository.ResetIndexToHead(originFolder);
                indexReset = true;
            }

            repository.StagePath(originFolder, relativePath);
            stagedPaths.Add(relativePath);
        }

        /// <summary>Refuses when this attempt staged nothing (spec-review finding, #393): an
        /// attempt that never staged also never ran the known-clean index reset (see
        /// <see cref="Stage"/>), so a bare commit here would commit whatever the index happens to
        /// hold — a crashed earlier attempt's orphan, under a message that never mentions it. No
        /// production caller commits without staging; refusing keeps that a loud contract instead
        /// of a silent hazard.</summary>
        public void Commit(string message)
        {
            if (stagedPaths.Count == 0)
                throw new InvalidOperationException(
                    "Nothing was staged in this attempt; refusing to commit whatever the index happens to hold.");

            repository.CommitStaged(originFolder, message);
            stagedPaths.Clear();
        }

        /// <summary>Abandonment is the default: anything staged that never reached
        /// <see cref="Commit"/> is unstaged here, so the exception path of the risky work between
        /// the two is nothing the caller has to choreograph. Best-effort per path — a cleanup
        /// failure must not throw out of a <c>using</c> exit and mask the original exception; a
        /// survivor is the next attempt's <c>ResetIndexToHead</c> problem, exactly as before.</summary>
        public void Dispose()
        {
            foreach (var relativePath in stagedPaths)
            {
                try
                {
                    repository.UnstagePath(originFolder, relativePath);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex,
                        "Failed to unstage {RelativePath} in {OriginFolder} while abandoning a ledger commit attempt",
                        relativePath, originFolder);
                }
            }

            stagedPaths.Clear();
            gate.Release();
        }
    }

    /// <summary>The gitdir/worktree pair for an origin folder — deterministic from the folder's own
    /// canonical path, so the same origin always resolves to the same repo without any durable
    /// state beyond the filesystem itself (the ledger's own commits are the only "is this vendored
    /// yet" record; see <see cref="IsTrackedAtHead"/>).</summary>
    public (string GitDir, string WorkTree) PathsFor(string originFolder)
    {
        var workTree = Path.GetFullPath(originFolder);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(workTree)))[..16];
        var gitDir = Path.Combine(options.RootPath, key, "gitdir");
        return (gitDir, workTree);
    }

    /// <summary>Creates the repo (gitdir + <c>git init -b main</c>) if it does not already exist.
    /// Idempotent: a second call against the same origin folder is a no-op, verified by checking for
    /// the gitdir's own <c>HEAD</c> file rather than tracking "already initialized" anywhere else —
    /// the filesystem is the only source of truth here, same as the truth-partition model's DB. Not
    /// safe to call concurrently against the same origin folder from two threads without an external
    /// lock — the attempt scope's per-origin gate (<see cref="BeginAttemptAsync"/>) is what
    /// actually makes this check-then-create sequence race-free in production.</summary>
    internal void EnsureRepo(string originFolder)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        if (RepoExists(originFolder)) return;

        // No Directory.CreateDirectory(workTree) (suite-axis review, #393): the work tree *is* the
        // origin folder, and every path here runs only after a plugin binary was read out of that
        // very folder — it exists by construction. If it ever doesn't, git (or Process.Start)
        // fails into the callers' existing best-effort catch rather than this class fabricating an
        // empty origin folder to init into.
        Directory.CreateDirectory(gitDir);
        GitCli.Run(gitDir, workTree, "init", "-q", "-b", "main");
        logger.LogInformation("Ledger created for {OriginFolder} at {GitDir}", workTree, gitDir);
    }

    /// <summary>Read-only sibling of <see cref="EnsureRepo"/>'s own check-then-create guard — never
    /// creates anything. What a status read (#368) needs: "has this origin folder ever been
    /// vendored into at all", answered the same way <see cref="EnsureRepo"/> already does (the
    /// gitdir's own <c>HEAD</c> file), so a status read against an origin folder nothing has ever
    /// touched skips it rather than fabricating an empty repo just to ask it for its own status.</summary>
    public bool RepoExists(string originFolder)
    {
        var (gitDir, _) = PathsFor(originFolder);
        return File.Exists(Path.Combine(gitDir, "HEAD"));
    }

    /// <summary>Working-tree changes against this origin's ledger repo — <c>git status --porcelain -z</c>,
    /// scoped to <c>*.ledger/*</c> paths only (#368). That scoping is load-bearing, not decoration:
    /// the repo's working tree *is* the origin folder itself (<see cref="PathsFor"/>), which already
    /// holds the plugin binary, <c>.bak</c> backups, <c>meta.ini</c> and whatever else Mod Management
    /// put there — with no pathspec, every one of those shows up as an untracked (<c>??</c>) "change"
    /// alongside genuine ledger dirt, since <see cref="EnsureRepo"/> never writes a <c>.gitignore</c>.
    /// Confirmed empirically (not assumed) before landing this: an unscoped <c>git status --porcelain</c>
    /// over a fixture folder reported the plugin file, its backup and an unrelated loose file as
    /// changes; scoping with <c>-- "*.ledger/*"</c> reported only the genuine ledger entry. Git's own
    /// pathspec glob crosses <c>/</c> (unlike a shell glob), so this one pattern matches at any depth
    /// under any <c>&lt;plugin&gt;.ledger/</c> root — verified against <see cref="LedgerRecordPath"/>'s
    /// three-level-deep layout, not assumed from the pattern reading right.
    ///
    /// <c>-z</c> is load-bearing too, not a formatting nicety (review finding, #368): the plain
    /// <c>--porcelain</c> form C-quotes and octal-escapes any path containing a non-ASCII byte under
    /// git's default <c>core.quotePath=true</c> (confirmed empirically: a record under
    /// <c>Café.esp</c> came back as <c>"Caf\303\251.esp.ledger/..."</c>, quotes included) — a modding
    /// scene with routinely accented/Cyrillic/CJK plugin names would silently fail
    /// <see cref="LedgerRecordPath.TryParse"/>'s <c>.yaml</c> suffix check on the trailing quote and
    /// the record would vanish from the panel with no error, the worst kind of bug this class can
    /// produce. <c>-z</c> NUL-terminates entries instead of newline-terminating them and disables
    /// quoting entirely, so the raw UTF-8 bytes come through unescaped.</summary>
    public IReadOnlyList<(char StatusCode, string RelativePath)> WorkingTreeStatus(string originFolder)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        var output = GitCli.Run(gitDir, workTree, "status", "--porcelain", "-z", "--", "*.ledger/*");
        var fields = new Queue<string>(output.Split('\0', StringSplitOptions.RemoveEmptyEntries));
        var entries = new List<(char, string)>();
        while (fields.TryDequeue(out var field))
        {
            if (field.Length < 4) continue;

            // Porcelain v1: "XY <path>" — X is the index status, Y the working-tree status. Every
            // path this method can ever see is unstaged dirt (RecordVendor/LedgerGroupCommitter
            // always stage-then-commit atomically, per LedgerRepository's own class remarks — see
            // ResetIndexToHead), so Y is the one that carries real information; X is read as a
            // fallback only for the crash-recovery edge case those remarks describe (a stray staged
            // entry an earlier attempt's own UnstagePath never reached).
            var indexStatus = field[0];
            var worktreeStatus = field[1];
            var path = field[3..].Replace('/', Path.DirectorySeparatorChar);
            var code = worktreeStatus != ' ' ? worktreeStatus : indexStatus;
            entries.Add((code, path));

            // Under -z, a rename/copy entry (R/C in either status column) carries the origin path as
            // a second NUL-terminated field immediately after the current one — not a change this
            // class's own callers ever produce today (nothing here renames a ledger path), but the
            // field must still be consumed rather than misread as the next entry's own status line.
            if (indexStatus is 'R' or 'C' || worktreeStatus is 'R' or 'C') fields.TryDequeue(out _);
        }

        return entries;
    }

    /// <summary>Whether <paramref name="relativePath"/> already exists at <c>HEAD</c> on
    /// <c>main</c> — the ledger's own "is this record vendored yet" question, answered by asking git
    /// directly rather than keeping a separate tracked-record table (truth partition: no state
    /// beyond {binary, text@refs}).</summary>
    public bool IsTrackedAtHead(string originFolder, string relativePath)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        return GitCli.TryRun(gitDir, workTree, out _, "cat-file", "-e", $"HEAD:{ToGitPath(relativePath)}");
    }

    /// <summary>Top-level <c>&lt;plugin&gt;.ledger</c> directory names tracked at <c>HEAD</c> —
    /// what a lifecycle-reconciliation pass (#392) needs to know which plugins this origin's repo
    /// currently has a ledger tree for, read from git history rather than the working tree (a
    /// removed plugin's tree may already be gone from disk, or may still be sitting there as the
    /// orphan reconciliation exists to catch — either way, HEAD is the source of truth for "does the
    /// ledger still consider this tracked"). <c>git ls-tree</c> with no <c>-r</c> lists only the
    /// tree-ish's immediate children; <c>-d</c> restricts those to directories, so a same-named
    /// ordinary file at the root (not a shape the ledger's own writers ever produce, but not this
    /// method's job to assume) is excluded rather than misread as a ledger tree. Empty, not a
    /// throw, on an unborn <c>HEAD</c> (a repo whose <see cref="EnsureRepo"/> ran but nothing has
    /// been staged and committed into it yet) — the same "ask git, tolerate no answer" shape
    /// <see cref="RepoExists"/> already applies to a repo that was never created at all.</summary>
    public IReadOnlyList<string> LedgerTreeNamesAtHead(string originFolder)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        if (!GitCli.TryRun(gitDir, workTree, out var output, "ls-tree", "-d", "--name-only", "-z", "HEAD"))
            return [];

        return output.Split('\0', StringSplitOptions.RemoveEmptyEntries)
            .Where(name => name.EndsWith(LedgerRecordPath.LedgerSuffix, StringComparison.Ordinal))
            .ToList();
    }

    /// <summary>Every record path tracked at <c>HEAD</c> under one <c>&lt;plugin&gt;.ledger</c>
    /// directory (<c>git ls-tree -r</c>, pathspec-scoped) — what a reconciliation pass needs to
    /// recover an orphan's own tracked FormKeys (via <see cref="LedgerRecordPath.TryParse"/>)
    /// without walking a working tree that, for an already-removed plugin, may hold nothing to
    /// walk. Sibling of <see cref="LedgerTreeNamesAtHead"/> (that one lists the trees; this one
    /// lists one tree's own leaves) — kept separate rather than folded into a single "give me
    /// everything" call, since every caller so far has needed exactly one or the other, never
    /// both from one HEAD read.</summary>
    public IReadOnlyList<string> TrackedRecordPaths(string originFolder, string ledgerTreeDirName)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        if (!GitCli.TryRun(gitDir, workTree, out var output, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ledgerTreeDirName))
            return [];

        return output.Split('\0', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Replace('/', Path.DirectorySeparatorChar))
            .ToList();
    }

    /// <summary>Resets the index to <c>HEAD</c> (<c>git reset</c>, no pathspec — the working tree is
    /// untouched) — establishes a known-clean index before a staging sequence begins, rather than
    /// assuming one was inherited from whatever the previous attempt against this origin folder
    /// left behind (review finding, #371 — see the class remarks). Without this, a stray
    /// staged-but-never-committed entry from an earlier attempt whose own <see cref="UnstagePath"/>
    /// never ran (the process died between <see cref="StagePath"/> and
    /// <see cref="CommitStaged"/>/<see cref="UnstagePath"/>, or <see cref="UnstagePath"/> itself
    /// failed) would sit in the index until *some* later, unrelated successful commit against this
    /// origin folder swept it in too — silently including a file it never touched, under a message
    /// that never mentions it. Call it once, before the first <see cref="StagePath"/> of an
    /// attempt — calling it again partway through would also wipe out that attempt's own staged
    /// paths. Safe even before any commit exists (an unborn <c>HEAD</c>): verified directly, not
    /// assumed — <c>git reset</c> with no ref argument clears the index to empty in that case
    /// rather than erroring.</summary>
    internal void ResetIndexToHead(string originFolder)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        GitCli.Run(gitDir, workTree, "reset", "-q");
    }

    /// <summary>Reads <paramref name="relativePath"/>'s text as it stood at <paramref name="commitish"/>
    /// (<c>git show &lt;commitish&gt;:&lt;path&gt;</c>) — a point-in-time read that touches neither
    /// the working tree nor the index. What reverting a record needs to recover its state at an
    /// earlier commit (#371 AC3) before that state is re-staged through the normal edit path;
    /// <paramref name="commitish"/> is any git revision expression (a full or short SHA, a ref —
    /// git decides, this is a pass-through).</summary>
    public string ReadTextAtCommit(string originFolder, string relativePath, string commitish)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        return GitCli.Run(gitDir, workTree, "show", $"{commitish}:{ToGitPath(relativePath)}");
    }

    /// <summary>Stages <paramref name="relativePath"/>'s current working-tree content into the
    /// index (<c>git add</c>) — captures it for a later <see cref="CommitStaged"/> regardless of
    /// what the working-tree file holds by the time that call happens. Caller is responsible for
    /// having written the text to be captured to that path first.</summary>
    internal void StagePath(string originFolder, string relativePath)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        GitCli.Run(gitDir, workTree, "add", "--", ToGitPath(relativePath));
    }

    /// <summary>Commits whatever is currently staged — the text <see cref="StagePath"/>
    /// captured, not the working-tree file's content at commit time, which the caller may have since
    /// overwritten. For a vendor's first-touch call this is the baseline commit every later diff is
    /// measured against; for a save-time call (<c>LedgerGroupCommitter</c>) this is the group's own
    /// commit (ADR-0040/#371). Call it only once everything that could still fail has already
    /// succeeded.
    ///
    /// Deliberately no trailing pathspec on the <c>git commit</c> invocation, despite one narrowing
    /// every other command here to its own path: empirically, <c>git commit -- &lt;path&gt;</c>
    /// does <b>not</b> commit the index's staged content for that path — it re-reads the current
    /// working-tree file, which is exactly the dirt this method must not commit. A bare
    /// <c>git commit</c> commits the index as a whole, which is what actually produces "the staged
    /// pristine blob, not today's working-tree content" — verified directly (two shell probes, one
    /// per form) before landing this, not assumed from a plausible-sounding pathspec-narrowing
    /// analogy to <c>add</c>/<c>reset</c>. The attempt scope's unstage-on-dispose (and the reset
    /// before its first stage) is the guard against this committing an unrelated stray index entry
    /// from an earlier failed attempt.</summary>
    internal void CommitStaged(string originFolder, string message)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        GitCli.Run(gitDir, workTree,
            "-c", "user.email=modbench@local", "-c", "user.name=Modbench",
            "commit", "-q", "-m", message);
    }

    /// <summary>Undoes a <see cref="StagePath"/> that will never reach <see cref="CommitStaged"/>
    /// (the risky work in between threw) — <c>git reset -- path</c>, which works even before any
    /// commit exists. Without this, a failed attempt's staged-but-uncommitted content would sit
    /// in the index until some *later*, unrelated successful commit swept it in too (since
    /// <see cref="CommitStaged"/> commits the whole index, by design — see its own remarks).</summary>
    internal void UnstagePath(string originFolder, string relativePath)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        GitCli.Run(gitDir, workTree, "reset", "-q", "--", ToGitPath(relativePath));
    }

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');

    // ---- Cross-repo atomicity journal (#372) ----------------------------------------------------

    /// <summary>One repo's intended advance, as the spike prototype shaped it (<c>{ repo,
    /// expectedContentHash }</c>) plus <see cref="Message"/> — a faithful completion of that shape,
    /// not a deviation from it (orchestrator-directed, #372): the spike's own finding only names the
    /// decision-rich part (what a caller must validate and persist before advancing anything), and
    /// recovering a lagging repo still needs the exact commit message the interrupted attempt would
    /// have used — inventing a placeholder here would misrepresent history for no reason.
    /// <see cref="OriginFolder"/> serializes as <c>repo</c> to match that shape literally.</summary>
    internal sealed record JournalEntry(
        [property: JsonPropertyName("repo")] string OriginFolder,
        string ExpectedContentHash,
        string Message);

    private static readonly JsonSerializerOptions JournalJsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>The tree object SHA the current index would produce if committed right now
    /// (<c>git write-tree</c>) — computed from the index, not the working tree, so it reflects
    /// exactly what a following <see cref="CommitStaged"/> would commit. This is the journal's
    /// "expected content hash": deterministic regardless of commit timestamp/author, so recovery can
    /// compare it against a HEAD produced at a different wall-clock time than the crashed attempt's
    /// own would have been.</summary>
    internal string WriteTree(string originFolder)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        return GitCli.Run(gitDir, workTree, "write-tree").Trim();
    }

    private string JournalDirectory => Path.Combine(options.RootPath, "_journal");

    private string JournalPath(Guid groupId) => Path.Combine(JournalDirectory, $"{groupId:N}.json");

    /// <summary>Persists <paramref name="entries"/> as <paramref name="groupId"/>'s journal —
    /// overwrites whatever was there before (the caller passes the *current* full set each time, not
    /// a delta). Temp-file-then-rename, not a direct write: a crash mid-write of the journal file
    /// itself must leave either the old complete content or the new complete content, never a torn
    /// one <see cref="Recover"/> would fail to parse — the same constraint <c>Edits/PreparedPluginSave.cs</c>
    /// meets the same way for the plugin binary itself, not a pattern already present elsewhere in
    /// this class. Every caller that persists a journal — including <see cref="Recover"/>'s own
    /// rewrite of a partially-resolved one — must go through this (and <see cref="DeleteJournal"/>)
    /// rather than writing the file directly, or that guarantee only holds for some writers.</summary>
    internal void WriteJournal(Guid groupId, IReadOnlyList<JournalEntry> entries)
    {
        Directory.CreateDirectory(JournalDirectory);
        var path = JournalPath(groupId);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(entries, JournalJsonOptions));
        File.Move(tmp, path, overwrite: true);
    }

    internal void DeleteJournal(Guid groupId)
    {
        var path = JournalPath(groupId);
        if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>Every leftover journal file — each one a group save that still had at least one repo
    /// unresolved the last time this process ran. Empty (not a throw) when the journal directory
    /// doesn't exist at all — the common case, a clean prior shutdown (AC4). A file whose name isn't
    /// a bare GUID, or whose content isn't valid JSON, is skipped rather than crashing the whole
    /// read — this directory holds nothing but journals this class itself writes, but a corrupt file
    /// must not block recovering every *other* one.</summary>
    internal IReadOnlyList<(string Path, Guid GroupId, List<JournalEntry> Entries)> ReadJournals()
    {
        if (!Directory.Exists(JournalDirectory)) return [];

        var result = new List<(string, Guid, List<JournalEntry>)>();
        foreach (var file in Directory.GetFiles(JournalDirectory, "*.json"))
        {
            if (!Guid.TryParseExact(Path.GetFileNameWithoutExtension(file), "N", out var groupId)) continue;
            try
            {
                var entries = JsonSerializer.Deserialize<List<JournalEntry>>(File.ReadAllText(file), JournalJsonOptions) ?? [];
                result.Add((file, groupId, entries));
            }
            catch (JsonException ex)
            {
                logger.LogWarning(ex, "Ledger journal {Path} is not valid JSON; skipped by recovery", file);
            }
        }

        return result;
    }

    /// <summary>Replays every leftover journal at startup (#372) — the recovery half of the
    /// prepare/journal/advance protocol <see cref="LedgerGroupCommitter"/> drives. Per entry: a repo
    /// whose <c>HEAD</c> tree already matches the journaled <see cref="JournalEntry.ExpectedContentHash"/>
    /// already advanced (no-op — the crash landed after the real commit but before this process got to
    /// remove the entry, or after a prior recovery pass already completed it); one whose *currently
    /// staged* index tree matches instead was interrupted before its own <c>git commit</c> ever ran —
    /// completed here via <see cref="CommitStaged"/> directly, bypassing <see cref="CommitAttempt"/>'s
    /// normal in-memory staged-path bookkeeping (that bookkeeping belongs to a live caller sequencing
    /// its own stage/commit calls; recovery instead independently re-verifies the index against the
    /// journaled hash immediately before acting, which is what makes this bypass safe rather than a
    /// hole in the "one door" discipline). Anything else — neither matches — refuses loudly: logs the
    /// divergence at Error and leaves the entry (and its journal file) in place for manual inspection,
    /// never guessing at what to commit.
    ///
    /// Best-effort per entry and per file, same discipline as <see cref="LedgerLifecycleReconciler"/>
    /// — one bad entry must not stop recovery from resolving every other one, or crash startup
    /// entirely.</summary>
    public void Recover()
    {
        foreach (var (_, groupId, entries) in ReadJournals())
        {
            var remaining = new List<JournalEntry>();
            foreach (var entry in entries)
            {
                try
                {
                    if (!TryRecoverEntry(entry)) remaining.Add(entry);
                }
                catch (Exception ex)
                {
                    logger.LogError(ex,
                        "Ledger recovery failed for {OriginFolder} (group {GroupId}); leaving its journal entry in place",
                        entry.OriginFolder, groupId);
                    remaining.Add(entry);
                }
            }

            // Through the same door every other journal write goes through (review finding): a
            // hand-rolled File.WriteAllText/File.Delete here would skip WriteJournal's temp-file-
            // then-rename discipline and reintroduce the torn-write risk in exactly the path most
            // exposed to it — recovery running again after a crash mid-rewrite of its own output.
            if (remaining.Count == 0) DeleteJournal(groupId);
            else WriteJournal(groupId, remaining);
        }
    }

    // Returns true once the entry is resolved (already advanced, or completed here) — false means
    // "refused", and the caller keeps it in the journal.
    private bool TryRecoverEntry(JournalEntry entry)
    {
        if (!RepoExists(entry.OriginFolder))
        {
            logger.LogError(
                "Ledger recovery: {OriginFolder} has no repo at all but was journaled to advance to {ExpectedContentHash}; refusing — nothing to complete",
                entry.OriginFolder, entry.ExpectedContentHash);
            return false;
        }

        var (gitDir, workTree) = PathsFor(entry.OriginFolder);
        if (GitCli.TryRun(gitDir, workTree, out var headTreeRaw, "rev-parse", "HEAD^{tree}"))
        {
            var headTree = headTreeRaw.Trim();
            if (headTree == entry.ExpectedContentHash) return true; // already advanced
        }

        var stagedTree = WriteTree(entry.OriginFolder);
        if (stagedTree == entry.ExpectedContentHash)
        {
            CommitStaged(entry.OriginFolder, entry.Message);
            logger.LogInformation(
                "Ledger recovery: completed an interrupted commit for {OriginFolder} ({ExpectedContentHash})",
                entry.OriginFolder, entry.ExpectedContentHash);
            return true;
        }

        logger.LogError(
            "Ledger recovery: {OriginFolder} diverged from its journaled intent (expected tree {ExpectedContentHash}, staged tree {StagedTree}); refusing to complete this commit automatically",
            entry.OriginFolder, entry.ExpectedContentHash, stagedTree);
        return false;
    }
}
