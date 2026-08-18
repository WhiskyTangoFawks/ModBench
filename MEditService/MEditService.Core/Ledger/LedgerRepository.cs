using System.Security.Cryptography;
using System.Text;
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
}
