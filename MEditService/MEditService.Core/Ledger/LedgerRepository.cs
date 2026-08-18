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
/// Staging and committing are deliberately separate operations (<see cref="StagePath"/> /
/// <see cref="CommitStaged"/>), not one atomic "commit this text" call: a caller stages a path's
/// current working-tree content into the index immediately after writing it, then does the work
/// that can still fail, and only calls <see cref="CommitStaged"/> (a bare <c>git commit</c>,
/// deliberately no pathspec — see its own remarks) once all of that has succeeded, or
/// <see cref="UnstagePath"/> if it didn't. A bare <c>git commit</c> commits whatever is in the
/// index — not whatever the working-tree file currently holds — so the working-tree file can be
/// overwritten *between* staging and committing without the commit ever capturing that later
/// content: it still commits what was staged earlier. A failure between the two calls leaves
/// nothing committed and, once <see cref="UnstagePath"/> runs, nothing staged either — not a
/// commit orphaned from work that never finished, and not a stray index entry a later, unrelated
/// commit could accidentally sweep in.
///
/// Two callers share this split (#371): <c>RecordVendor</c> stages a freshly-written pristine
/// blob before applying the risky field edits on top of it; <c>Ledger/LedgerGroupCommitter</c>
/// stages one or more already-tracked records' current dirt (written by <c>RecordVendor</c> on
/// every prior stage, per ADR-0040) right before a save's own commit. One stage primitive, reused
/// for both — never two parallel ones.
///
/// <see cref="UnstagePath"/> alone is not the whole guarantee (review finding, #371): it only
/// protects the attempt that calls it. If the process dies between <see cref="StagePath"/> and
/// <see cref="CommitStaged"/>/<see cref="UnstagePath"/> — or <see cref="UnstagePath"/> itself
/// throws — the orphaned index entry survives *this* attempt and sits waiting for whichever
/// commit against this origin folder happens next, vendor or save, to sweep it in silently. Both
/// callers close that gap the same way: <see cref="ResetIndexToHead"/> first, establishing a
/// known-clean index before staging anything for the current attempt, rather than assuming one
/// was inherited.
/// </summary>
public sealed class LedgerRepository(LedgerOptions options, ILogger<LedgerRepository> logger)
{
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
    /// lock — see <c>RecordVendor</c>'s per-origin-folder gate, which is what actually makes this
    /// check-then-create sequence race-free in production.</summary>
    public void EnsureRepo(string originFolder)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        if (RepoExists(originFolder)) return;

        Directory.CreateDirectory(gitDir);
        Directory.CreateDirectory(workTree);
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

    /// <summary>Working-tree changes against this origin's ledger repo — <c>git status --porcelain</c>,
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
    /// three-level-deep layout, not assumed from the pattern reading right.</summary>
    public IReadOnlyList<(char StatusCode, string RelativePath)> WorkingTreeStatus(string originFolder)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        var output = GitCli.Run(gitDir, workTree, "status", "--porcelain", "--", "*.ledger/*");
        var entries = new List<(char, string)>();
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            // Porcelain v1: "XY <path>" — X is the index status, Y the working-tree status. Every
            // path this method can ever see is unstaged dirt (RecordVendor/LedgerGroupCommitter
            // always stage-then-commit atomically, per LedgerRepository's own class remarks — see
            // ResetIndexToHead), so Y is the one that carries real information; X is read as a
            // fallback only for the crash-recovery edge case those remarks describe (a stray staged
            // entry an earlier attempt's own UnstagePath never reached).
            if (line.Length < 4) continue;
            var indexStatus = line[0];
            var worktreeStatus = line[1];
            var path = line[3..].Replace('/', Path.DirectorySeparatorChar);
            var code = worktreeStatus != ' ' ? worktreeStatus : indexStatus;
            entries.Add((code, path));
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
    public void ResetIndexToHead(string originFolder)
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
    public void StagePath(string originFolder, string relativePath)
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
    /// analogy to <c>add</c>/<c>reset</c>. <see cref="UnstagePath"/> is the caller's guard against
    /// this now committing an unrelated stray index entry from an earlier failed attempt.</summary>
    public void CommitStaged(string originFolder, string message)
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
    public void UnstagePath(string originFolder, string relativePath)
    {
        var (gitDir, workTree) = PathsFor(originFolder);
        GitCli.Run(gitDir, workTree, "reset", "-q", "--", ToGitPath(relativePath));
    }

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');
}
