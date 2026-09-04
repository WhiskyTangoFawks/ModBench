using System.Diagnostics;
using Serilog;

namespace MEditService.Core.Source;

/// <summary>Thin process wrapper over the real git CLI, the source's one execution boundary (ADR-0041).
/// No interface, no fake: every call states its own gitdir/worktree, the seam tests need —
/// scratch directories, never a mocked git.</summary>
internal static class GitCli
{
    // A missing git on PATH must surface as one named failure, never a raw exception cascade (ADR-0026).
    // Process.Start throws Win32Exception for a missing executable; anything else still surfaces here,
    // not at a random later Run.
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
        if (exitCode != 0) throw Failed(args, exitCode, stderr);
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

    /// <summary>Against a scratch index instead of <c>$GIT_DIR/index</c>: building a tree object must not
    /// disturb the edit branch's real index, which may carry the user's own staged dirt.</summary>
    internal static string RunWithIndex(string gitDir, string workTree, string indexFile, params string[] args)
    {
        var (exitCode, stdout, stderr) = Execute(gitDir, workTree, indexFile, args);
        if (exitCode != 0) throw Failed(args, exitCode, stderr);
        return stdout;
    }

    // Only the subcommand is named: the full argument vector can carry scratch paths onto the wire via
    // Results.Problem(ex.Message), so it goes to the log instead.
    private static InvalidOperationException Failed(string[] args, int exitCode, string stderr)
    {
        Log.Warning("git {Args} failed ({ExitCode}): {Stderr}", args, exitCode, stderr);
        return new InvalidOperationException($"git {args[0]} failed ({exitCode}): {stderr}");
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

        // Both streams read concurrently: draining one to completion before the other is the classic .NET
        // Process deadlock once a child fills a ~64 KB pipe buffer, and payloads here are not bounded.
        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start the git process.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        Task.WaitAll(stdoutTask, stderrTask);
        process.WaitForExit();
        return (process.ExitCode, stdoutTask.Result, stderrTask.Result);
    }
}

/// <summary>Thrown when git cannot be run at all — named and actionable, since git on PATH is a
/// stated product requirement (ADR-0041).</summary>
public sealed class GitUnavailableException : Exception
{
    private const string DefaultMessage = "git was not found on PATH. Modbench's tracking features require git to be installed and on PATH.";

    // RCS1194: the three standard exception constructors; EnsureOnPath throws through the
    // Exception?-taking one below, which pins the one actionable message.
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
