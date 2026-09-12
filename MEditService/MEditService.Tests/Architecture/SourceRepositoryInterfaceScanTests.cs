using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>The Source repository is entered through its interface (ADR-0007): git and the layout
/// are named nowhere else. Track, the classifier and its deferral sit in the folder but belong to
/// Commands, so they are scanned as callers.</summary>
public sealed class SourceRepositoryInterfaceScanTests
{
    private static readonly string[] ProductionRoots =
        ["MEditService.Core", "MEditService.Api", "MEditService.Bridge"];

    private const string RepositoryRoot = "MEditService.Core/Source";

    private static readonly string[] CallersInsideTheFolder =
    [
        "MEditService.Core/Source/TrackService.cs",
        "MEditService.Core/Source/ExternalChangeClassifier.cs",
        "MEditService.Core/Source/ExternalChangeDeferral.cs",
    ];

    // The git CLI and the object name it prints, the meta.ini reader, the unit a path resolves to and
    // the resolver answering one, the tree reader, the writer, then the verbs beneath the documents.
    private static readonly string[] HiddenMechanism =
    [
        "GitCli", "GitBlobHash", "MetaIni", "SourceUnit", "Locate", "SourceTreeDocuments",
        "PristineFileWriter", "WorkingTreeStatus", "ReadCommittedSourceText", "CommittedSourceHashes",
        "TryParseDocumentPath", "RootStringIn", "RecordBodyFromOwnerBytes",
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
            + "answers documents by identity, the facts about a unit and what to watch, and keeps git "
            + "and the layout behind that (ADR-0007), so ask it for the answer as a value:\n"
            + string.Join("\n", named));
    }

    // An empty finding and a mis-typed root read the same; this is what tells them apart.
    [Fact]
    public void TheScan_ReadsTheRepositoryItselfAndNamesItsOwnMechanism()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var named = Sites(
            root,
            [.. SourceTree.CSharpFiles(Path.Combine(root, RepositoryRoot.Replace('/', Path.DirectorySeparatorChar)))
                .Where(file => !IsCallerInsideTheFolder(root, file))],
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
            .Where(file => !file.StartsWith(repository, StringComparison.Ordinal)
                || IsCallerInsideTheFolder(root, file))];
    }

    private static bool IsCallerInsideTheFolder(string root, string file) =>
        CallersInsideTheFolder.Contains(
            Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'), StringComparer.Ordinal);

    // A count per file and needle, not a line number: a reference is the unit of work, and a line
    // number would fail the gate for any unrelated edit above one.
    private static List<string> Sites(string root, IEnumerable<string> files, string[] needles) =>
        [.. files
            .SelectMany(file => needles
                .Select(needle => (Needle: needle, Count: Regex.Count(File.ReadAllText(file), $@"\b{needle}\b")))
                .Where(hit => hit.Count > 0)
                .Select(hit => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {hit.Needle}: {hit.Count}"))
            .Order(StringComparer.Ordinal)];
}
