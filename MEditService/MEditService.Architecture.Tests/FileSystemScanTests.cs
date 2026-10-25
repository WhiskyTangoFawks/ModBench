using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class FileSystemScanTests
{
    private static readonly string[] LoadOrderNeedles = [@"File\.", @"Directory\."];

    private const string CreateTempSubdirectorySpelledSoTheScratchFolderScanPassesThisFile = @"\bCreateTempSubdirector[y]";

    private static readonly string[] CodecNeedles =
        [@"\bFile\.", @"\bDirectory\.", @"\bModPath", @"\bRecordLocator", CreateTempSubdirectorySpelledSoTheScratchFolderScanPassesThisFile];

    private static readonly string[] IndexNeedlesWhoseStaticsAreAnchoredAgainstAMemberOfTheSameName =
    [
        @"(?<![\w.])File\.", @"(?<![\w.])Directory\.", @"(?<![\w.])Path\.",
        @"\bFileStream\b", @"\bFileInfo\b", @"\bDirectoryInfo\b", @"\bSystem\.IO\b",
    ];

    private static readonly string[] IndexFilesThatReachTheStoreOrReconcileWithTheDisk =
    [
        "MEditService.RecordIndex/Store/Store.cs",
        "MEditService.RecordIndex/Store/IndexFile.cs",
        "MEditService.RecordIndex/Indexer.cs",
        "MEditService.RecordIndex/HeldPlugins.cs",
        "MEditService.RecordIndex/IndexScope.cs",
    ];

    private static readonly string[] CommandsNeedles =
    [
        @"(?:(?<![\w.])|(?<=\bSystem\.IO\.))(?:Path|File|Directory)\.[A-Za-z]",
        @"(?<![\w.])new\s+(?:System\.IO\.)?(?:FileInfo|DirectoryInfo|FileStream|FileSystemWatcher)\b",
    ];

    public static TheoryData<string, string[], string[], int> BoxesAboveTheRepositories => new()
    {
        { "MEditService.LoadOrder", LoadOrderNeedles, [], 5 },
        { "MEditService.Codec", CodecNeedles, [], 50 },
        { "MEditService.RecordIndex", IndexNeedlesWhoseStaticsAreAnchoredAgainstAMemberOfTheSameName, IndexFilesThatReachTheStoreOrReconcileWithTheDisk, 50 },
        { "MEditService.Commands", CommandsNeedles, [], 20 },
    };

    [Theory]
    [MemberData(nameof(BoxesAboveTheRepositories))]
    public void ABoxAboveTheRepositories_NamesNoFileSystem_BecauseOnlyARepositoryReadsASystemOfRecord(
        string folder, string[] needles, string[] exemptFiles, int minimumWalked)
    {
        var root = ServiceProjects.SolutionDirectory();
        var walked = Walked(root, folder, exemptFiles);

        var sites = Sites(root, walked, needles);

        Assert.True(walked.Count > minimumWalked, $"The scan walked only {walked.Count} files under {folder}.");
        Assert.True(
            sites.Count == 0,
            $"{folder} names the file system. Only a repository reads or writes a system of record "
            + "(target-architecture.md), so ask the Source repository for a path or the Plugin adapter for "
            + "the bytes:\n" + string.Join("\n", sites));
    }

    [Fact]
    public void TheScan_PassesAnExemptFileAndAComment_AndNamesAnOperationElsewhere()
    {
        using var root = new ScratchDirectory("medit-file-system-scan-");
        ScratchFiles.Plant(root, "Box/Reads.cs", "var held = File.ReadAllBytes(path); // File.Exists guards it\n");
        ScratchFiles.Plant(root, "Box/Commented.cs", "// Directory.CreateDirectory runs in the adapter\n");
        ScratchFiles.Plant(root, "Box/Store.cs", "File.Delete(path);");

        Assert.Equal(
            [@"Box/Reads.cs: File\.: 1"],
            Sites(root, Walked(root, "Box", ["Box/Store.cs"]), LoadOrderNeedles));
    }

    [Fact]
    public void TheIndexNeedles_PassAMemberNamedLikeAStatic()
    {
        using var root = new ScratchDirectory("medit-file-system-scan-");
        ScratchFiles.Plant(root, "Box/Reads.cs",
            "if (!File.Exists(p)) return;\nvar d = Directory.GetFiles(p);\nvar n = plugin.Path.Length;\n");

        Assert.Equal(
            [@"Box/Reads.cs: (?<![\w.])Directory\.: 1", @"Box/Reads.cs: (?<![\w.])File\.: 1"],
            Sites(root, Walked(root, "Box", []), IndexNeedlesWhoseStaticsAreAnchoredAgainstAMemberOfTheSameName));
    }

    [Fact]
    public void TheCommandsNeedles_CountQualifiedAndConstructedOperations_AndPassAMemberNamedLikeAStatic()
    {
        using var root = new ScratchDirectory("medit-file-system-scan-");
        ScratchFiles.Plant(root, "Box/Edits.cs",
            "var tree = Path.Combine(modFolder, root);\n"
            + "var held = System.IO.File.ReadAllBytes(unit.FullPath);\n"
            + "var entry = new FileInfo(tree);\n"
            + "var folder = new System.IO.DirectoryInfo(tree);\n"
            + "var anchored = file.RelativePath.Equals(other.RelativePath);\n"
            + "if (edit.Path.Count == 0) return;\n");

        Assert.Equal(
            [
                $"Box/Edits.cs: {CommandsNeedles[0]}: 2",
                $"Box/Edits.cs: {CommandsNeedles[1]}: 2",
            ],
            Sites(root, Walked(root, "Box", []), CommandsNeedles));
    }

    private static List<string> Walked(string root, string folder, string[] exemptFiles) =>
        [.. SourceTree.CSharpFiles(Path.Combine(root, folder))
            .Where(file => !exemptFiles.Contains(SourceTree.Relative(root, file), StringComparer.Ordinal))];

    private static List<string> Sites(string root, IEnumerable<string> files, string[] needles) =>
        SourceTree.Sites(root, files, [.. needles.Select(needle => (needle, new Regex(needle)))], CodeOf);

    private static string CodeOf(string file) =>
        string.Join('\n', File.ReadAllLines(file).Select(line => Regex.Replace(line, "//.*$", "")));
}
