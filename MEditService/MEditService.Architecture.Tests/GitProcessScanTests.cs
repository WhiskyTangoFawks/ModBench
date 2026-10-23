using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class GitProcessScanTests
{
    private const string GitRunner = "MEditService.SourceAdapter/GitCli.cs";

    private static readonly string[] ProcessStarts = [@"\bProcessStartInfo\b", @"\bProcess\.Start\b", @"\bnew\s+Process\b"];

    [Fact]
    public void NothingButGitCli_StartsAProcess()
    {
        var root = ServiceProjects.SolutionDirectory();
        var walked = ServiceProjects.ProductionFiles(root);

        AssertOnlyTheRunnerStarts(root, walked);
        Assert.True(
            Starts(root, walked).Contains(GitRunner),
            $"{GitRunner} starts no process — delete the exemption rather than leaving it pre-authorized.");
    }

    [Fact]
    public void TheScan_PassesTheRunner_AndNamesAProcessStartedElsewhere()
    {
        using var root = new ScratchDirectory("medit-git-process-scan-");
        ScratchFiles.Plant(root, GitRunner, "var psi = new ProcessStartInfo(\"git\");\nProcess.Start(psi);\n");
        ScratchFiles.Plant(root, "MEditService.Commands/StatusProbe.cs", "using var git = Process.Start(new ProcessStartInfo(\"git\", \"status\"));\n");
        ScratchFiles.Plant(root, "MEditService.Commands/InitializerProbe.cs", "using var git = new Process { StartInfo = info }.Start();\n");
        var files = SourceTree.CSharpFiles(root).ToList();

        Assert.Equal(
            ["MEditService.Commands/InitializerProbe.cs", "MEditService.Commands/StatusProbe.cs"],
            StartsOutsideTheRunner(root, files));
        var failure = Assert.Throws<Xunit.Sdk.TrueException>(() => AssertOnlyTheRunnerStarts(root, files));
        Assert.Contains("MEditService.Commands/StatusProbe.cs", failure.Message, StringComparison.Ordinal);
    }

    private static void AssertOnlyTheRunnerStarts(string root, IReadOnlyList<string> files)
    {
        var elsewhere = StartsOutsideTheRunner(root, files);
        Assert.True(
            elsewhere.Count == 0,
            $"A production file outside {GitRunner} starts a process. Run git through GitCli, which runs "
            + "every call without optional locks: a read holding .git/index.lock fails the commit or "
            + "rebase the user runs in the same repository (ADR-0003):\n"
            + string.Join("\n", elsewhere));
    }

    private static List<string> StartsOutsideTheRunner(string root, IEnumerable<string> files) =>
        [.. Starts(root, files).Where(file => file != GitRunner)];

    private static List<string> Starts(string root, IEnumerable<string> files) =>
        [.. files
            .Where(file => ProcessStarts.Any(start => Regex.IsMatch(File.ReadAllText(file), start)))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)];
}
