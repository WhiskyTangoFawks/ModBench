using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class CommandsAndEditsPathScanTests
{
    // Neither a member named Path nor a type ending in Path (RelativePath, FieldPath) is a BCL call,
    // and the System.IO. spelling of one is: the qualifier decides, not the dot before the type.
    private static readonly Regex Operation = new(
        @"(?:(?<![\w.])|(?<=\bSystem\.IO\.))(Path|File|Directory)\.[A-Za-z]+"
        + @"|(?<![\w.])new\s+(?:System\.IO\.)?(?:FileInfo|DirectoryInfo|FileStream|FileSystemWatcher)\b",
        RegexOptions.Compiled);

    private static readonly string[] ScannedRoots = ["MEditService.Commands"];

    [Fact]
    public void CommandsAndEdits_NameNoPathFileOrDirectoryOperation()
    {
        var counts = Counts(ArchitectureTests.SolutionDirectory(), ScannedRoots);

        Assert.True(
            counts.Count == 0,
            "Path, file or directory operations in Commands or Edits — ask the Source repository for the "
            + "path or the Plugin adapter for the bytes instead of operating on disk directly:\n"
            + string.Join("\n", counts));
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
            Directory.CreateDirectory(Path.Combine(root, "MEditService.Commands", "Edits", "obj"));
            File.WriteAllText(
                Path.Combine(root, "MEditService.Commands", "Edits", "PluginCompileService.cs"),
                "var tree = Path.Combine(modFolder, root);\n"
                + "var held = System.IO.File.ReadAllBytes(unit.FullPath);\n"
                + "var entry = new FileInfo(tree);\n"
                + "var folder = new System.IO.DirectoryInfo(tree);\n"
                + "var anchored = file.RelativePath.Equals(other.RelativePath);\n"
                + "if (edit.Path.Count == 0) return;\n"
                + "var again = Path.Combine(tree, \"x\");\n");
            File.WriteAllText(
                Path.Combine(root, "MEditService.Commands", "Edits", "obj", "Generated.cs"),
                "var tree = Path.Combine(modFolder, root);\n");
            Directory.CreateDirectory(Path.Combine(root, "MEditService.Commands"));
            File.WriteAllText(
                Path.Combine(root, "MEditService.Commands", "TrackHandler.cs"),
                "var bytes = File.ReadAllBytes(plugin.Path);\n");

            var counts = Counts(root, ScannedRoots);

            Assert.Equal(
                [
                    "MEditService.Commands/Edits/PluginCompileService.cs: File.ReadAllBytes: 1",
                    "MEditService.Commands/Edits/PluginCompileService.cs: Path.Combine: 2",
                    "MEditService.Commands/Edits/PluginCompileService.cs: new FileInfo: 1",
                    "MEditService.Commands/Edits/PluginCompileService.cs: new System.IO.DirectoryInfo: 1",
                    "MEditService.Commands/TrackHandler.cs: File.ReadAllBytes: 1",
                ],
                counts);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

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
