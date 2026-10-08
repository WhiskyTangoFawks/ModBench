using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class QueriesScanTests
{
    private const string QueriesRoot = "MEditService.Index/Queries";

    private static readonly (string Label, string Pattern)[] FileSystemNeedlesWhoseStaticsAreAnchoredAgainstAMemberAccessOfTheSameName =
    [
        ("File.", @"(?<![\w.])File\."),
        ("Directory.", @"(?<![\w.])Directory\."),
        ("Path.", @"(?<![\w.])Path\."),
        ("FileStream", @"\bFileStream\b"),
        ("FileInfo", @"\bFileInfo\b"),
        ("DirectoryInfo", @"\bDirectoryInfo\b"),
        ("System.IO", @"\bSystem\.IO\b"),
    ];

    [Fact]
    public void Queries_NameNoFileSystem_BecauseAQueryHidesTheIndexAndAnswersFromARow()
    {
        var root = ServiceProjects.SolutionDirectory();

        var walked = ScannedFiles(root, QueriesRoot);
        var named = Sites(root, walked, FileSystemNeedlesWhoseStaticsAreAnchoredAgainstAMemberAccessOfTheSameName);

        Assert.True(walked.Count > 10, $"The Queries scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A query reads the disk. Queries hide the Index's reads and reach no system of record "
            + "(ADR-0014), so the answer comes from a row:\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void TheFileSystemScan_CountsPerFileAndSymbol_AndSkipsBuildOutputAndAMemberOfTheSameName()
    {
        using var root = new ScratchDirectory("medit-queries-scan-");
        Directory.CreateDirectory(Path.Combine(root, "Q", "obj"));
        File.WriteAllText(
            Path.Combine(root, "Q", "Reads.cs"),
            "if (!File.Exists(p)) return;\nvar b = File.ReadAllBytes(p);\nvar d = Directory.GetFiles(p);\n");
        File.WriteAllText(Path.Combine(root, "Q", "Member.cs"), "var p = plugin.Path.Length;");
        File.WriteAllText(Path.Combine(root, "Q", "obj", "Generated.cs"), "File.Delete(p);");
        File.WriteAllText(Path.Combine(root, "Q", "Clean.cs"), "return index.Reads.At(key);");

        Assert.Equal(
            ["Q/Reads.cs: Directory.: 1", "Q/Reads.cs: File.: 2"],
            Sites(root, ScannedFiles(root, "Q"), FileSystemNeedlesWhoseStaticsAreAnchoredAgainstAMemberAccessOfTheSameName));
    }

    private static List<string> ScannedFiles(string root, string scannedRoot) =>
        [.. SourceTree.CSharpFiles(Path.Combine(root, scannedRoot.Replace('/', Path.DirectorySeparatorChar)))];

    private static List<string> Sites(
        string root, IEnumerable<string> files, (string Label, string Pattern)[] needles) =>
        [.. files
            .SelectMany(file => needles
                .Select(needle => (needle.Label, Count: Regex.Count(File.ReadAllText(file), needle.Pattern)))
                .Where(hit => hit.Count > 0)
                .Select(hit => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {hit.Label}: {hit.Count}"))
            .Order(StringComparer.Ordinal)];
}
