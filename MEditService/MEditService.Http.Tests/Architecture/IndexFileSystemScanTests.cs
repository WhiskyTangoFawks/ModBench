using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class IndexFileSystemScanTests
{
    private const string IndexRoot = "MEditService.Index";

    private static readonly string[] FilesOfTheStoreAndTheReconcile =
    [
        "MEditService.Index/Store.cs",
        "MEditService.Index/IndexFile.cs",
        "MEditService.Index/Reconciler.cs",
        "MEditService.Index/HeldPlugins.cs",
        "MEditService.Index/IndexScope.cs",
    ];

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
    public void TheIndex_NamesNoFileSystem_OutsideTheStoreAndTheReconcile_BecauseAQueryAnswersFromARow()
    {
        var root = ServiceProjects.SolutionDirectory();

        var walked = ScannedFiles(root, IndexRoot)
            .Where(file => !FilesOfTheStoreAndTheReconcile.Contains(Relative(root, file), StringComparer.Ordinal))
            .ToList();
        var named = Sites(root, walked, FileSystemNeedlesWhoseStaticsAreAnchoredAgainstAMemberAccessOfTheSameName);

        Assert.True(walked.Count > 50, $"The Index scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "The Index reads the disk outside the Store and the reconcile. A query reaches no system of "
            + "record but through an adapter (ADR-0014), so the answer comes from a row:\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void TheFileSystemScan_CountsPerFileAndSymbol_AndSkipsBuildOutputAndAMemberOfTheSameName()
    {
        using var root = new ScratchDirectory("medit-index-scan-");
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
                .Select(hit => $"{Relative(root, file)}: {hit.Label}: {hit.Count}"))
            .Order(StringComparer.Ordinal)];

    private static string Relative(string root, string file) =>
        Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/');
}
