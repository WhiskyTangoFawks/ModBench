using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class SourceRepositoryInterfaceScanTests
{
    private static readonly IReadOnlyList<string> ProductionRoots =
        ServiceProjects.Production(ArchitectureTests.SolutionDirectory());

    private const string RepositoryRoot = "MEditService.SourceAdapter";

    private static readonly string[] HiddenMechanism =
    [
        "GitCli", "SourceUnit", "Locate", "SourceTreeDocuments",
        "PristineFileWriter", "WorkingTreeStatus", "ReadCommittedSourceText",
        "ParseDocumentPath", "RootStringIn", "RecordBodyFromOwnerBytes",
    ];

    [Fact]
    public void NothingOutsideTheSourceRepository_NamesItsGitOrLayoutMechanism()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root);
        var named = Sites(root, walked, HiddenMechanism);

        Assert.True(walked.Count > 50, $"The repository-interface scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A type outside the Source repository names its git or layout mechanism. The repository "
            + "answers documents by identity and the facts about a unit, and keeps git "
            + "and the layout behind that (ADR-0007), so ask it for the answer as a value:\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void TheScan_ReadsTheRepositoryItselfAndNamesItsOwnMechanism()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var named = Sites(
            root,
            [.. SourceTree.CSharpFiles(Path.Combine(root, RepositoryRoot.Replace('/', Path.DirectorySeparatorChar)))],
            HiddenMechanism);

        Assert.True(
            named.Count > 10,
            $"The repository's own files name its mechanism {named.Count} time(s) — the scan is reading "
            + "the wrong tree, so it would pass by finding nothing.");
    }

    private static List<string> ScannedFiles(string root)
    {
        var repository = Path.Combine(root, RepositoryRoot.Replace('/', Path.DirectorySeparatorChar))
            + Path.DirectorySeparatorChar;

        return [.. ProductionRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => !file.StartsWith(repository, StringComparison.Ordinal))];
    }

    private static List<string> Sites(string root, IEnumerable<string> files, string[] needles) =>
        [.. files
            .SelectMany(file => needles
                .Select(needle => (Needle: needle, Count: Regex.Count(File.ReadAllText(file), $@"\b{needle}\b")))
                .Where(hit => hit.Count > 0)
                .Select(hit => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {hit.Needle}: {hit.Count}"))
            .Order(StringComparer.Ordinal)];
}
