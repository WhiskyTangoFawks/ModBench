using System.Diagnostics;

namespace MEditService.Tests.TestSupport;

/// <summary>A test's own git process wrapper, independent of MEditService.SourceRepo's internal
/// GitCli: a test verifying tracked state from outside SourceRepo.Tests runs git itself rather than
/// reaching for the box's internals.</summary>
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
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        Task.WaitAll(stdoutTask, stderrTask);
        process.WaitForExit();
        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        if (throwOnFailure && process.ExitCode != 0)
        {
            var subcommand = args.Length > 0 ? args[0] : "(no subcommand)";
            throw new InvalidOperationException($"git {subcommand} failed ({process.ExitCode}): {stderr}");
        }
        return (process.ExitCode, stdout, stderr);
    }
}
