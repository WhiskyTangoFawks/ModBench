using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>A path names the Source repository (ADR-0014.5); a plugin's bytes name the Plugin
/// adapter (ADR-0005.2). Commands and Edits ask one of those layers instead. Counted against an
/// allowlist that stays empty.</summary>
public sealed class CommandsAndEditsPathScanTests
{
    // Neither a member named Path nor a type ending in Path (RelativePath, FieldPath) is a BCL call,
    // and the System.IO. spelling of one is: the qualifier decides, not the dot before the type.
    private static readonly Regex Operation = new(
        @"(?:(?<![\w.])|(?<=\bSystem\.IO\.))(Path|File|Directory)\.[A-Za-z]+"
        + @"|(?<![\w.])new\s+(?:System\.IO\.)?(?:FileInfo|DirectoryInfo|FileStream|FileSystemWatcher)\b",
        RegexOptions.Compiled);

    private static readonly string[] ScannedRoots = ["MEditService.Commands", "MEditService.Commands/Edits"];

    private const string AllowlistPath = "MEditService.Tests/Architecture/commands-and-edits-path-allowlist.txt";

    [Fact]
    public void CommandsAndEdits_NameAPathFileOrDirectoryOperation_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ArchitectureTests.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ScannedRoots),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    // Zero offenders and zero files walked read the same: a ScannedRoots typo that scans nothing
    // would still pass the assertion above.
    [Fact]
    public void TheScan_WalksMoreThanTwentyFiles()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedRoots.SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r))).Count();

        Assert.True(walked > 20, $"The Commands/Edits path scan walked only {walked} files under {string.Join(", ", ScannedRoots)}.");
    }

    [Fact]
    public void TheScan_CountsAPlantedOperationPerFile_AndPassesTheCallsThatAreNotOne()
    {
        var root = Directory.CreateTempSubdirectory("medit-commands-edits-path-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "MEditService.Core", "Edits", "obj"));
            File.WriteAllText(
                Path.Combine(root, "MEditService.Core", "Edits", "PluginCompileService.cs"),
                "var tree = Path.Combine(modFolder, root);\n"
                + "var held = System.IO.File.ReadAllBytes(unit.FullPath);\n"
                + "var entry = new FileInfo(tree);\n"
                + "var folder = new System.IO.DirectoryInfo(tree);\n"
                + "var anchored = file.RelativePath.Equals(other.RelativePath);\n"
                + "if (edit.Path.Count == 0) return;\n"
                + "var again = Path.Combine(tree, \"x\");\n");
            File.WriteAllText(
                Path.Combine(root, "MEditService.Core", "Edits", "obj", "Generated.cs"),
                "var tree = Path.Combine(modFolder, root);\n");
            Directory.CreateDirectory(Path.Combine(root, "MEditService.Core", "Commands"));
            File.WriteAllText(
                Path.Combine(root, "MEditService.Core", "Commands", "KeepExternalChangeHandler.cs"),
                "var bytes = File.ReadAllBytes(plugin.Path);\n");

            var counts = Counts(root, ScannedRoots);

            Assert.Equal(
                [
                    "MEditService.Commands/KeepExternalChangeHandler.cs: File.ReadAllBytes: 1",
                    "MEditService.Commands/Edits/PluginCompileService.cs: File.ReadAllBytes: 1",
                    "MEditService.Commands/Edits/PluginCompileService.cs: Path.Combine: 2",
                    "MEditService.Commands/Edits/PluginCompileService.cs: new FileInfo: 1",
                    "MEditService.Commands/Edits/PluginCompileService.cs: new System.IO.DirectoryInfo: 1",
                ],
                counts);

            var unallowed = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [], AllowlistPath));
            Assert.Contains(
                "MEditService.Commands/Edits/PluginCompileService.cs: Path.Combine: 2", unallowed.Message, StringComparison.Ordinal);
            Assert.Contains(
                "MEditService.Commands/KeepExternalChangeHandler.cs: File.ReadAllBytes: 1",
                unallowed.Message, StringComparison.Ordinal);

            var stale = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [.. counts, "MEditService.Commands/Edits/Gone.cs: Directory.CreateDirectory: 1"], AllowlistPath));
            Assert.Contains(
                "MEditService.Commands/Edits/Gone.cs: Directory.CreateDirectory: 1", stale.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertCountsMatchAllowlist(
        IReadOnlyList<string> counts, IReadOnlyList<string> allowlist, string allowlistPath)
    {
        var unallowed = counts.Except(allowlist, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var unmatched = allowlist.Except(counts, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();

        Assert.True(
            unallowed.Count == 0 && unmatched.Count == 0,
            $"Path, file or directory operations in Commands or Edits differ from {allowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — ask the Source repository for the "
            + "path or the Plugin adapter for the bytes instead of operating on disk directly, or get the "
            + "maintainer's ruling before adding a line:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no count ({unmatched.Count}) — delete them; the shortening of "
            + "this list is what the work is measured by:\n"
            + string.Join("\n", unmatched));
    }

    // A count, not a line number: an operation is the unit of work, and a line number would fail the
    // gate for any unrelated edit above one.
    private static List<string> Counts(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)))
            .SelectMany(file => Occurrences(File.ReadAllText(file))
                .Select(o => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {o.Operation}: {o.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<(string Operation, int Count)> Occurrences(string text) =>
        Operation.Matches(text)
            .Select(m => m.Value)
            .GroupBy(v => v, StringComparer.Ordinal)
            .Select(g => (Operation: g.Key, Count: g.Count()));
}
