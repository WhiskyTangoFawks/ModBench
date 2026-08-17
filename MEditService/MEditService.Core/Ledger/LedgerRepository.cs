using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Ledger;

/// <summary>
/// Owns one hidden per-mod git repo (ADR-0040): gitdir under <see cref="LedgerOptions.RootPath"/>,
/// working tree = the mod folder, no <c>.git</c> inside the mod. One repo per mod folder — keyed by
/// the folder's own canonical absolute path, not by Mod Management's opaque <c>origin</c> string
/// (which Editing must treat as uninterpreted and isn't guaranteed filename-safe) — reused across
/// every record vendored from that mod, created once (<see cref="EnsureRepo"/> is idempotent).
/// </summary>
public sealed class LedgerRepository(LedgerOptions options, ILogger<LedgerRepository> logger)
{
    /// <summary>The gitdir/worktree pair for a mod folder — deterministic from the folder's own
    /// canonical path, so the same mod always resolves to the same repo without any durable state
    /// beyond the filesystem itself (the ledger's own commits are the only "is this vendored yet"
    /// record; see <see cref="IsTrackedAtHead"/>).</summary>
    public (string GitDir, string WorkTree) PathsFor(string modFolderAbsolutePath)
    {
        var workTree = Path.GetFullPath(modFolderAbsolutePath);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(workTree)))[..16];
        var gitDir = Path.Combine(options.RootPath, key, "gitdir");
        return (gitDir, workTree);
    }

    /// <summary>Creates the repo (gitdir + <c>git init -b main</c>) if it does not already exist.
    /// Idempotent: a second call against the same mod folder is a no-op, verified by checking for
    /// the gitdir's own <c>HEAD</c> file rather than tracking "already initialized" anywhere else —
    /// the filesystem is the only source of truth here, same as the truth-partition model's DB.</summary>
    public void EnsureRepo(string modFolderAbsolutePath)
    {
        var (gitDir, workTree) = PathsFor(modFolderAbsolutePath);
        if (File.Exists(Path.Combine(gitDir, "HEAD"))) return;

        Directory.CreateDirectory(gitDir);
        Directory.CreateDirectory(workTree);
        GitCli.Run(gitDir, workTree, "init", "-q", "-b", "main");
        logger.LogInformation("Ledger created for {ModFolder} at {GitDir}", workTree, gitDir);
    }

    /// <summary>Whether <paramref name="relativePath"/> already exists at <c>HEAD</c> on
    /// <c>main</c> — the ledger's own "is this record vendored yet" question, answered by asking git
    /// directly rather than keeping a separate tracked-record table (truth partition: no state
    /// beyond {binary, text@refs}).</summary>
    public bool IsTrackedAtHead(string modFolderAbsolutePath, string relativePath)
    {
        var (gitDir, workTree) = PathsFor(modFolderAbsolutePath);
        return GitCli.TryRun(gitDir, workTree, out _, "cat-file", "-e", $"HEAD:{ToGitPath(relativePath)}");
    }

    /// <summary>Commits the pristine text already written to <paramref name="relativePath"/> in the
    /// working tree — the vendor commit every later diff is measured against. Caller is responsible
    /// for having written the file before calling this (and for not calling it twice for the same
    /// path — see <see cref="IsTrackedAtHead"/>).</summary>
    public void CommitPristine(string modFolderAbsolutePath, string relativePath, string message)
    {
        var (gitDir, workTree) = PathsFor(modFolderAbsolutePath);
        var gitPath = ToGitPath(relativePath);
        GitCli.Run(gitDir, workTree, "add", "--", gitPath);
        GitCli.Run(gitDir, workTree,
            "-c", "user.email=modbench@local", "-c", "user.name=Modbench",
            "commit", "-q", "-m", message, "--", gitPath);
    }

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');
}
