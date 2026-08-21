using System.Diagnostics;

namespace MEditService.Core.Source;

/// <summary>
/// Thin process wrapper over the real git CLI — the source's one execution boundary (ADR-0040/#370).
/// No interface, no fake implementation: there is exactly one way to run git, and every call states
/// its own gitdir/worktree explicitly (via <c>GIT_DIR</c>/<c>GIT_WORK_TREE</c>), which is the whole
/// seam tests need — pointing at scratch directories, never a mocked git. Internal: callers go
/// through <see cref="SourceRepository"/>, which owns the git operation vocabulary the source
/// actually needs; tests reach this directly (via <c>InternalsVisibleTo</c>) to assert on the real
/// repo the same vocabulary produced.
/// </summary>
internal static class GitCli
{
    // Checked once, early, by every entry point about to run git for the first time in a call
    // (SourceRepository.Track) — a missing git-on-PATH must surface as one named, actionable
    // failure, never as a raw exception cascade (comment 1, #414 / ADR-0026). `Process.Start` throws
    // Win32Exception ("No such file or directory") when the executable can't be found on PATH; that
    // is the one expected failure mode this wraps — anything else (git present but broken) still
    // surfaces here rather than at a random later `Run` call, since the check runs before any of
    // those.
    internal static void EnsureOnPath()
    {
        try
        {
            var psi = new ProcessStartInfo("git", "--version") { RedirectStandardOutput = true, RedirectStandardError = true };
            using var process = Process.Start(psi) ?? throw new GitUnavailableException();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new GitUnavailableException();
        }
        catch (Exception ex) when (ex is not GitUnavailableException)
        {
            throw new GitUnavailableException(ex);
        }
    }

    internal static string Run(string gitDir, string workTree, params string[] args)
    {
        var (exitCode, stdout, stderr) = Execute(gitDir, workTree, null, args);
        if (exitCode != 0)
            throw new InvalidOperationException($"git {string.Join(' ', args)} failed ({exitCode}): {stderr}");
        return stdout;
    }

    /// <summary>Runs git without throwing on a non-zero exit — for existence checks
    /// (<c>git cat-file -e</c>) where "not found" is an expected, non-exceptional outcome.</summary>
    internal static bool TryRun(string gitDir, string workTree, out string stdout, params string[] args)
    {
        var (exitCode, output, _) = Execute(gitDir, workTree, null, args);
        stdout = output;
        return exitCode == 0;
    }

    /// <summary>
    /// <see cref="Run"/> against a scratch index file instead of the repo's own <c>$GIT_DIR/index</c>
    /// — #417's <c>SourceRepository.CommitPristineToMain</c> needs to build a tree object (<c>add</c>,
    /// <c>write-tree</c>) without disturbing whatever the edit branch's real index currently holds
    /// (which may itself carry the user's own staged dirt). <paramref name="workTree"/> is a scratch
    /// directory too in that caller, never the mod folder — plumbing that touches neither the mod
    /// folder's working tree nor its index is the whole point of "without checking main out".
    /// </summary>
    internal static string RunWithIndex(string gitDir, string workTree, string indexFile, params string[] args)
    {
        var (exitCode, stdout, stderr) = Execute(gitDir, workTree, indexFile, args);
        if (exitCode != 0)
            throw new InvalidOperationException($"git {string.Join(' ', args)} failed ({exitCode}): {stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) Execute(string gitDir, string workTree, string? indexFile, string[] args)
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
        if (indexFile != null) psi.Environment["GIT_INDEX_FILE"] = indexFile;

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

/// <summary>Thrown by <see cref="GitCli.EnsureOnPath"/> when git cannot be run at all — named and
/// actionable (the message names the product requirement, ADR-0041: "git on PATH is a stated
/// product requirement") rather than surfacing as whatever raw exception the OS gave for a missing
/// executable.</summary>
public sealed class GitUnavailableException : Exception
{
    private const string DefaultMessage = "git was not found on PATH. Modbench's tracking features require git to be installed and on PATH.";

    // RCS1194: the three standard exception constructors, for well-behaved rethrow/serialization
    // callers generally — not how GitCli.EnsureOnPath itself throws this (the Exception?-taking
    // constructor below), which pins the one actionable message every caller should see.
    public GitUnavailableException() : base(DefaultMessage)
    {
    }

    public GitUnavailableException(string message) : base(message)
    {
    }

    public GitUnavailableException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal GitUnavailableException(Exception? inner) : base(DefaultMessage, inner)
    {
    }
}
