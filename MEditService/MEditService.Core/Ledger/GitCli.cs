using System.Diagnostics;

namespace MEditService.Core.Ledger;

/// <summary>
/// Thin process wrapper over the real git CLI — the ledger's one execution boundary (ADR-0040/#370).
/// No interface, no fake implementation: there is exactly one way to run git, and every call states
/// its own gitdir/worktree explicitly (via <c>GIT_DIR</c>/<c>GIT_WORK_TREE</c>), which is the whole
/// seam tests need — pointing at scratch directories, never a mocked git. Internal: callers go
/// through <see cref="LedgerRepository"/>, which owns the git operation vocabulary the ledger
/// actually needs; tests reach this directly (via <c>InternalsVisibleTo</c>) to assert on the real
/// repo the same vocabulary produced.
/// </summary>
internal static class GitCli
{
    internal static string Run(string gitDir, string workTree, params string[] args)
    {
        var (exitCode, stdout, stderr) = Execute(gitDir, workTree, args);
        if (exitCode != 0)
            throw new InvalidOperationException($"git {string.Join(' ', args)} failed ({exitCode}): {stderr}");
        return stdout;
    }

    /// <summary>Runs git without throwing on a non-zero exit — for existence checks
    /// (<c>git cat-file -e</c>) where "not found" is an expected, non-exceptional outcome.</summary>
    internal static bool TryRun(string gitDir, string workTree, out string stdout, params string[] args)
    {
        var (exitCode, output, _) = Execute(gitDir, workTree, args);
        stdout = output;
        return exitCode == 0;
    }

    private static (int ExitCode, string Stdout, string Stderr) Execute(string gitDir, string workTree, string[] args)
    {
        var psi = new ProcessStartInfo("git")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = workTree,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        psi.Environment["GIT_DIR"] = gitDir;
        psi.Environment["GIT_WORK_TREE"] = workTree;

        // Read both streams concurrently, not sequentially: reading stdout to completion before
        // touching stderr (or vice versa) is the classic .NET Process deadlock — a child that fills
        // one OS pipe buffer (~64 KB) while the parent blocks fully draining the other wedges both
        // sides. Unlikely at this class's typical payloads (a single-record JSON diff, a short `git
        // log`) but not bounded by construction, so not safe to leave sequential.
        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start the git process.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        Task.WaitAll(stdoutTask, stderrTask);
        process.WaitForExit();
        return (process.ExitCode, stdoutTask.Result, stderrTask.Result);
    }
}
