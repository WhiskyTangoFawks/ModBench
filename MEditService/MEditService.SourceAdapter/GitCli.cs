using System.ComponentModel;
using System.Diagnostics;
using Serilog;

namespace MEditService.SourceAdapter;

/// <summary>The git CLI behind the Source adapter (target-architecture.d2 medit_repositories.sourceadapter).
/// No interface, no fake: every call states its own gitdir/worktree, the seam tests need —
/// scratch directories, never a mocked git.</summary>
internal static class GitCli
{
    // A missing git on PATH must surface as one named failure, never a raw exception cascade (ADR-0019).
    // Process.Start throws Win32Exception for a missing executable; anything else still surfaces here,
    // not at a random later Run.
    internal static void EnsureOnPath()
    {
        try
        {
            var psi = new ProcessStartInfo("git", "--version") { RedirectStandardOutput = true, RedirectStandardError = true };
            using var process = Process.Start(psi) ?? throw SourceStopException.GitUnavailable();
            process.WaitForExit();
            if (process.ExitCode != 0) throw SourceStopException.GitUnavailable();
        }
        catch (Exception ex) when (ex is not SourceStopException)
        {
            throw SourceStopException.GitUnavailable(ex);
        }
    }

    internal static string Run(string gitDir, string workTree, params string[] args)
    {
        var (exitCode, stdout, stderr) = Execute(gitDir, workTree, args);
        if (exitCode != 0) throw Failed(args, exitCode, stderr);
        return stdout;
    }

    /// <summary>Runs git without throwing on a non-zero exit — for existence checks
    /// (<c>git cat-file -e</c>) where "not found" is an expected, non-exceptional outcome.</summary>
    internal static bool TryRun(string gitDir, string workTree, out string stdout, params string[] args) =>
        RunForExitCode(gitDir, workTree, out stdout, args) == 0;

    /// <summary>For a command whose exit code is its answer, as <c>git grep</c>'s 1 is "nothing
    /// matched".</summary>
    internal static int RunForExitCode(string gitDir, string workTree, out string stdout, params string[] args)
    {
        var (exitCode, output, _) = Execute(gitDir, workTree, args);
        stdout = output;
        return exitCode;
    }

    // Only the subcommand and the exit code are named: the arguments and git's stderr can carry paths
    // onto the wire via a refusal's message, so they go to the log instead.
    private static SourceStopException Failed(string[] args, int exitCode, string stderr)
    {
        Log.Warning("git {Args} failed ({ExitCode}): {Stderr}", args, exitCode, stderr);
        return SourceStopException.GitFailed($"git {args[0]} failed ({exitCode})");
    }

    private static ProcessStartInfo StartInfo(string gitDir, string workTree, string[] args)
    {
        var psi = new ProcessStartInfo("git")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = workTree,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        psi.Environment["GIT_DIR"] = gitDir;
        psi.Environment["GIT_WORK_TREE"] = workTree;
        // A read that refreshes the index takes index.lock, which fails the commit or rebase the
        // user is running in the same repository at that moment (ADR-0003).
        psi.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        return psi;
    }

    private static (int ExitCode, string Stdout, string Stderr) Execute(string gitDir, string workTree, string[] args)
    {
        using var process = Start(StartInfo(gitDir, workTree, args), workTree);
        // Closed at once: git otherwise inherits this process's stdin, and a socket never reaches EOF.
        process.StandardInput.Close();

        // Draining one stream to completion before the other is the classic .NET Process deadlock once
        // a child fills a ~64 KB pipe buffer. A thread, so this call blocks on a process, never a task.
        var stderr = string.Empty;
        var drainStderr = new Thread(() => stderr = process.StandardError.ReadToEnd()) { IsBackground = true };
        drainStderr.Start();
        var stdout = process.StandardOutput.ReadToEnd();
        drainStderr.Join();

        process.WaitForExit();
        return (process.ExitCode, stdout, stderr);
    }

    // Starting git throws Win32Exception both for a git that cannot run and for a working directory
    // that is gone; the working directory standing leaves only git.
    private static Process Start(ProcessStartInfo psi, string workTree)
    {
        try
        {
            return Process.Start(psi) ?? throw SourceStopException.GitUnavailable();
        }
        catch (Win32Exception ex) when (Directory.Exists(workTree))
        {
            throw SourceStopException.GitUnavailable(ex);
        }
        catch (Win32Exception ex)
        {
            throw SourceStopException.Inaccessible(ex.Message, ex);
        }
    }
}
