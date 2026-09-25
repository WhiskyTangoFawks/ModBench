using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>GitCli is the service's one process boundary, so every git call runs without optional
/// locks: the user's own commit or rebase fails on an index.lock a background read holds
/// (ADR-0003).</summary>
public sealed class GitProcessScanTests
{
    private const string GitRunner = "MEditService.SourceAdapter/GitCli.cs";

    private static readonly string[] ProcessStarts = [@"\bProcessStartInfo\b", @"\bProcess\.Start\b"];

    [Fact]
    public void NothingButGitCli_StartsAProcess()
    {
        var root = ArchitectureTests.SolutionDirectory();
        var walked = ProductionFiles(root);

        Assert.True(walked.Count > 100, $"The process-start scan walked only {walked.Count} files.");
        AssertOnlyTheRunnerStarts(root, walked);
        Assert.True(
            Starts(root, walked).Contains(GitRunner),
            $"{GitRunner} starts no process — delete the exemption rather than leaving it pre-authorized.");
    }

    [Fact]
    public void TheScan_PassesTheRunner_AndNamesAProcessStartedElsewhere()
    {
        var root = Directory.CreateTempSubdirectory("medit-git-process-scan-").FullName;
        try
        {
            var runner = Path.Combine(root, GitRunner.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(runner).Require());
            File.WriteAllText(runner, "var psi = new ProcessStartInfo(\"git\");\nProcess.Start(psi);\n");
            var rival = Path.Combine(root, "MEditService.Commands", "StatusProbe.cs");
            Directory.CreateDirectory(Path.GetDirectoryName(rival).Require());
            File.WriteAllText(rival, "using var git = Process.Start(new ProcessStartInfo(\"git\", \"status\"));\n");

            Assert.Equal(["MEditService.Commands/StatusProbe.cs"], StartsOutsideTheRunner(root, [runner, rival]));
            var failure = Assert.Throws<Xunit.Sdk.TrueException>(() => AssertOnlyTheRunnerStarts(root, [runner, rival]));
            Assert.Contains("MEditService.Commands/StatusProbe.cs", failure.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
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

    private static List<string> ProductionFiles(string root) =>
        [.. ServiceProjects.Production(root).SelectMany(project => SourceTree.CSharpFiles(ServiceProjects.Folder(root, project)))];

    private static List<string> Starts(string root, IEnumerable<string> files) =>
        [.. files
            .Where(file => ProcessStarts.Any(start => Regex.IsMatch(File.ReadAllText(file), start)))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)];
}
