using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using MEditService.RepositoriesLib;
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

    /// <summary>Has git check out the submodule at <paramref name="folder"/> at the commit its repository pins, with each of
    /// <paramref name="settings"/>. Asks for no credentials, and stops when <paramref name="cancel"/> does.</summary>
    internal static void UpdateSubmodule(string folder, IEnumerable<(string Key, string Value)> settings, CancellationToken cancel)
    {
        var path = Path.TrimEndingDirectorySeparator(folder);
        var parentPath = Path.GetDirectoryName(path) ?? path;
        WrittenFiles.CreateDirectory(parentPath);
        var parent = Path.GetFullPath(parentPath);
        WrittenFiles.Name([path, .. SourceRepositoryGit.WorkTreeAbove(path) is { } superproject ? [SourceRepositoryGit.GitDirOf(superproject)] : Array.Empty<string>()]);
        string[] args = [.. settings.SelectMany(setting => new[] { "-c", $"{setting.Key}={setting.Value}" }), "submodule", "update", "-q", "--init", "--", Path.GetFileName(path)];
        var psi = StartInfo(args, parent);
        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
        var (exitCode, _, stderr) = Execute(psi, parent, cancel);
        if (cancel.IsCancellationRequested) throw SourceStopException.GitFailed("the clone was cancelled");
        if (exitCode != 0) throw Failed("submodule", args, exitCode, stderr);
    }

    /// <summary>Runs git in <paramref name="at"/>, a folder of <paramref name="workTree"/>, where a pathspec is relative to it.</summary>
    internal static string Run(string gitDir, string workTree, string at, params string[] args)
    {
        var (exitCode, stdout, stderr) = Execute(gitDir, workTree, at, args);
        if (exitCode != 0) throw Failed(args[0], args, exitCode, stderr);
        return stdout;
    }

    /// <summary>As <see cref="Run"/>, with <paramref name="input"/> on git's stdin.</summary>
    internal static void RunFed(string gitDir, string workTree, string at, string input, params string[] args)
    {
        NameWrites(gitDir, workTree, args);
        var (exitCode, _, stderr) = Execute(StartInfo(gitDir, workTree, at, args), at, CancellationToken.None, input);
        if (exitCode != 0) throw Failed(args[0], args, exitCode, stderr);
    }

    /// <summary>Runs git without throwing on a non-zero exit — for existence checks
    /// (<c>git cat-file -e</c>) where "not found" is an expected, non-exceptional outcome.</summary>
    internal static bool TryRun(string gitDir, string workTree, string at, out string stdout, params string[] args) =>
        RunForExitCode(gitDir, workTree, at, out stdout, args) == 0;

    /// <summary>For a command whose exit code is its answer, as <c>git grep</c>'s 1 is "nothing
    /// matched".</summary>
    internal static int RunForExitCode(string gitDir, string workTree, string at, out string stdout, params string[] args)
    {
        var (exitCode, output, _) = Execute(gitDir, workTree, at, args);
        stdout = output;
        return exitCode;
    }

    // Only the subcommand and the exit code are named: the arguments and git's stderr can carry paths
    // onto the wire via a refusal's message, so they go to the log instead.
    private static SourceStopException Failed(string subcommand, string[] args, int exitCode, string stderr)
    {
        Log.Warning("git {Args} failed ({ExitCode}): {Stderr}", args, exitCode, stderr);
        return SourceStopException.GitFailed($"git {subcommand} failed ({exitCode})");
    }

    private static ProcessStartInfo StartInfo(string[] args, string workingDirectory)
    {
        var psi = new ProcessStartInfo("git")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Git writes UTF-8; unset, Windows decodes with the console's code page.
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            WorkingDirectory = workingDirectory,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        return psi;
    }

    private static ProcessStartInfo StartInfo(string gitDir, string workTree, string at, string[] args)
    {
        var psi = StartInfo(args, at);
        psi.Environment["GIT_DIR"] = gitDir;
        psi.Environment["GIT_WORK_TREE"] = workTree;
        // A read that refreshes git's index takes index.lock, which fails the commit or rebase the
        // user is running in the same repository at that moment (ADR-0003).
        psi.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        return psi;
    }

    private static (int ExitCode, string Stdout, string Stderr) Execute(string gitDir, string workTree, string at, string[] args)
    {
        NameWrites(gitDir, workTree, args);
        return Execute(StartInfo(gitDir, workTree, at, args), at, CancellationToken.None);
    }

    private static (int ExitCode, string Stdout, string Stderr) Execute(ProcessStartInfo psi, string at, CancellationToken cancel, string input = "")
    {
        using var process = Start(psi, at);
        using var stopping = cancel.Register(() => process.Kill(entireProcessTree: true));
        // Closed once written: git otherwise inherits this process's stdin, and a socket never reaches EOF.
        process.StandardInput.Write(input);
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

    private static readonly HashSet<string> Reads =
        ["status", "rev-parse", "ls-files", "ls-tree", "cat-file", "for-each-ref", "log", "diff", "show", "rev-list", "grep", "check-ignore", "check-attr"];

    private static readonly HashSet<string> ReadingArguments = ["--get", "--get-all", "--get-regexp", "--list", "--show-current", "--contains", "get-url"];

    private static readonly HashSet<string> WorkTreeWrites = ["checkout", "switch", "restore", "merge", "rebase", "stash", "clean", "pull"];

    private static readonly HashSet<string> WorkTreeResets = ["--hard", "--merge", "--keep"];

    // What a subcommand writes: nothing for a read, the git directory, and the work tree as well for one that writes it.
    private static void NameWrites(string gitDir, string workTree, string[] args)
    {
        var subcommand = args[0];
        var rest = args[1..];
        var operands = rest.Count(arg => !arg.StartsWith('-'));
        var reads = Reads.Contains(subcommand) || rest.Any(ReadingArguments.Contains)
            || subcommand is "remote" or "branch" && operands == 0
            || subcommand == "symbolic-ref" && operands < 2 && !rest.Any(arg => arg is "-d" or "--delete");
        if (reads) return;
        var writesTheWorkTree = WorkTreeWrites.Contains(subcommand)
            || subcommand == "reset" && rest.Any(WorkTreeResets.Contains)
            || subcommand == "rm" && !rest.Contains("--cached")
            || subcommand == "read-tree" && rest.Contains("-u");
        WrittenFiles.Name(writesTheWorkTree ? [gitDir, workTree] : [gitDir]);
    }

    // Starting git throws Win32Exception both for a git that cannot run and for a working directory
    // that is gone; the working directory standing leaves only git.
    private static Process Start(ProcessStartInfo psi, string at)
    {
        try
        {
            return Process.Start(psi) ?? throw SourceStopException.GitUnavailable();
        }
        catch (Win32Exception ex) when (Directory.Exists(at))
        {
            throw SourceStopException.GitUnavailable(ex);
        }
        catch (Win32Exception ex)
        {
            throw SourceStopException.Inaccessible(ex.Message, ex);
        }
    }
}
