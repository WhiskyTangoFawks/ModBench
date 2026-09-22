using System.Diagnostics;

namespace MEditService.TestSupport;

/// <summary>A test's own git process wrapper, for a test verifying tracked state directly against
/// the real tree.</summary>
public static class GitProbe
{
    public static string Run(string gitDir, string workTree, params string[] args) =>
        Execute(gitDir, workTree, null, args);

    public static string RunWithIndex(string gitDir, string workTree, string indexFile, params string[] args) =>
        Execute(gitDir, workTree, indexFile, args);

    /// <summary>Non-throwing: a failing exit code is an expected answer here, not a probe failure.</summary>
    public static bool TryRun(string gitDir, string workTree, out string stdout, params string[] args)
    {
        var (exitCode, output, _) = Execute(gitDir, workTree, null, args, throwOnFailure: false);
        stdout = output;
        return exitCode == 0;
    }

    private static string Execute(string gitDir, string workTree, string? indexFile, string[] args) =>
        Execute(gitDir, workTree, indexFile, args, throwOnFailure: true).Stdout;

    private static (int ExitCode, string Stdout, string Stderr) Execute(
        string gitDir, string workTree, string? indexFile, string[] args, bool throwOnFailure)
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

        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start the git process.");
        process.StandardInput.Close();

        // Draining one stream to completion before the other is the classic .NET Process deadlock once
        // a child fills a ~64 KB pipe buffer. A thread, so this call blocks on a process, never a task.
        var stderr = string.Empty;
        var drainStderr = new Thread(() => stderr = process.StandardError.ReadToEnd()) { IsBackground = true };
        drainStderr.Start();
        var stdout = process.StandardOutput.ReadToEnd();
        drainStderr.Join();

        process.WaitForExit();
        if (throwOnFailure && process.ExitCode != 0)
        {
            var subcommand = args.Length > 0 ? args[0] : "(no subcommand)";
            throw new InvalidOperationException($"git {subcommand} failed ({process.ExitCode}): {stderr}");
        }
        return (process.ExitCode, stdout, stderr);
    }
}
