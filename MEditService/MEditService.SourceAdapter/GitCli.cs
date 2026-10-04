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
    internal static bool TryRun(string gitDir, string workTree, out string stdout, params string[] args) =>
        RunForExitCode(gitDir, workTree, out stdout, args) == 0;

    /// <summary>For a command whose exit code is its answer, as <c>git grep</c>'s 1 is "nothing
    /// matched".</summary>
    internal static int RunForExitCode(string gitDir, string workTree, out string stdout, params string[] args)
    {
        var (exitCode, output, _) = Execute(gitDir, workTree, null, args);
        stdout = output;
        return exitCode;
    }

    /// <summary>Against a scratch index instead of <c>$GIT_DIR/index</c>: building a tree object must not
    /// disturb the checked-out branch's real index, which may carry the user's own staged dirt.</summary>
    internal static string RunWithIndex(string gitDir, string workTree, string indexFile, params string[] args)
    {
        var (exitCode, stdout, stderr) = Execute(gitDir, workTree, indexFile, args);
        if (exitCode != 0) throw Failed(args, exitCode, stderr);
        return stdout;
    }

    /// <summary>Each object's bytes in the order asked, from one <c>cat-file --batch</c>; null for one
    /// git reports missing. Null when git fails.</summary>
    internal static IReadOnlyList<byte[]?>? CatFileBatch(string gitDir, string workTree, IReadOnlyList<string> objects)
    {
        var psi = StartInfo(gitDir, workTree, null, ["cat-file", "--batch"]);
        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start the git process.");
        // Written from a thread of its own: git answers each object as it reads the next, and both
        // pipes fill.
        var feed = new Thread(() =>
        {
            using var input = process.StandardInput;
            foreach (var name in objects) input.Write(name + "\n");
        })
        { IsBackground = true };
        feed.Start();
        var stderr = string.Empty;
        var drainStderr = new Thread(() => stderr = process.StandardError.ReadToEnd()) { IsBackground = true };
        drainStderr.Start();
        using var stdout = new MemoryStream();
        process.StandardOutput.BaseStream.CopyTo(stdout);
        feed.Join();
        drainStderr.Join();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            Log.Warning("git cat-file --batch failed ({ExitCode}): {Stderr}", process.ExitCode, stderr);
            return null;
        }
        return BatchAnswers(stdout.ToArray(), objects.Count);
    }

    // "<oid> <type> <size>\n<bytes>\n" per object, or "<name> missing\n".
    private static List<byte[]?>? BatchAnswers(byte[] output, int count)
    {
        var answers = new List<byte[]?>(count);
        var at = 0;
        while (answers.Count < count)
        {
            var end = Array.IndexOf(output, (byte)'\n', at);
            if (end < 0) return null;
            var header = System.Text.Encoding.UTF8.GetString(output, at, end - at);
            at = end + 1;
            if (header.EndsWith(" missing", StringComparison.Ordinal))
            {
                answers.Add(null);
                continue;
            }
            var space = header.LastIndexOf(' ');
            if (space < 0 || !int.TryParse(header[(space + 1)..], out var size) || at + size > output.Length) return null;
            answers.Add(output[at..(at + size)]);
            at += size + 1;
        }
        return answers;
    }

    // Only the subcommand is named: the full argument vector can carry scratch paths onto the wire via
    // Results.Problem(ex.Message), so it goes to the log instead.
    private static GitCommandFailedException Failed(string[] args, int exitCode, string stderr)
    {
        Log.Warning("git {Args} failed ({ExitCode}): {Stderr}", args, exitCode, stderr);
        return new GitCommandFailedException($"git {args[0]} failed ({exitCode}): {stderr}");
    }

    private static ProcessStartInfo StartInfo(string gitDir, string workTree, string? indexFile, string[] args)
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
        if (indexFile != null) psi.Environment["GIT_INDEX_FILE"] = indexFile;
        // A read that refreshes the index takes index.lock, which fails the commit or rebase the
        // user is running in the same repository at that moment (ADR-0003).
        psi.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        return psi;
    }

    private static (int ExitCode, string Stdout, string Stderr) Execute(string gitDir, string workTree, string? indexFile, string[] args)
    {
        using var process = Process.Start(StartInfo(gitDir, workTree, indexFile, args))
            ?? throw new InvalidOperationException("Failed to start the git process.");
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
}

/// <summary>Thrown when git cannot be run at all (ADR-0007).</summary>
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

/// <summary>git ran and refused: a state of the repository, never a broken invariant of Modbench's
/// own.</summary>
internal sealed class GitCommandFailedException : InvalidOperationException
{
    public GitCommandFailedException()
    {
    }

    public GitCommandFailedException(string message) : base(message)
    {
    }

    public GitCommandFailedException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
