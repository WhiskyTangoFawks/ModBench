using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>The repository is the only type naming a path under source (ADR-0014 invariant 5): the
/// root folder, the door's file names and the JSON suffix are spelled in its own files and nowhere
/// else.</summary>
public sealed class SourcePathLiteralScanTests
{
    // The layout tokens, as C# string literals. A glob like "*.json" is a search filter rather than a
    // layout token and does not match: the needle carries the opening quote.
    private static readonly string[] Literals =
        ["\"source\"", "\"RecordData.json\"", "\"GroupRecordData.json\"", "\".json\"",
         "\".git\"", "\"HEAD\"", "\"packed-refs\"", "\"refs\""];

    private static readonly string[] ScannedRoots =
        ["MEditService.Codec", "MEditService.Commands", "MEditService.Http", "MEditService.Index",
         "MEditService.LoadOrder", "MEditService.PluginAdapter", "MEditService.Ports",
         "MEditService.Queries", "MEditService.SourceRepo", "MEditService.Watcher"];

    // The repository's own files: the partials of SourceRepository — only inside Source itself.
    private const string RepositoryFilePrefix = "SourceRepository";
    private const string RepositoryFolder = "MEditService.SourceRepo";

    private const string AllowlistPath = "MEditService.Http.Tests/Architecture/source-path-allowlist.txt";

    [Fact]
    public void TheStackOutsideTheRepository_SpellsALayoutLiteral_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ArchitectureTests.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ScannedRoots),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    [Fact]
    public void TheScan_PassesTheRepositorysOwnFiles_AndNamesALiteralPlantedElsewhere()
    {
        var root = Directory.CreateTempSubdirectory("medit-source-path-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "MEditService.SourceRepo", "obj"));
            File.WriteAllText(
                Path.Combine(root, "MEditService.SourceRepo", "SourceRepositoryLayout.cs"),
                "internal const string RootFolderName = \"source\";\n"
                + "internal const string RecordDataFileName = \"RecordData.json\";\n");
            Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Layer", "EditService.cs"),
                "var tree = Path.Combine(modFolder, \"source\", plugin);\n"
                + "var glob = Directory.EnumerateFiles(tree, \"*.json\");\n");
            File.WriteAllText(Path.Combine(root, "Layer", "obj", "Generated.cs"), "var root = \"source\";");
            // The same file name prefix, outside Source: not the repository, so it is counted.
            File.WriteAllText(
                Path.Combine(root, "Layer", "SourceRepositoryRival.cs"), "internal const string Root = \"source\";");

            var counts = Counts(root, ["MEditService.SourceRepo", "Layer"]);

            Assert.Equal(
                ["Layer/EditService.cs: \"source\": 1", "Layer/SourceRepositoryRival.cs: \"source\": 1"],
                counts);

            var unallowed = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [], AllowlistPath));
            Assert.Contains("Layer/EditService.cs: \"source\": 1", unallowed.Message, StringComparison.Ordinal);
            Assert.Contains("Layer/SourceRepositoryRival.cs: \"source\": 1", unallowed.Message, StringComparison.Ordinal);

            var stale = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [.. counts, "Layer/Gone.cs: \".json\": 2"], AllowlistPath));
            Assert.Contains("Layer/Gone.cs: \".json\": 2", stale.Message, StringComparison.Ordinal);
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
            $"Layout literals spelled outside the repository differ from {allowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — ask the repository for the path "
            + "instead of spelling it, or get the maintainer's ruling before adding a line:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no count ({unmatched.Count}) — delete them; the shortening of "
            + "this list is what the work is measured by:\n"
            + string.Join("\n", unmatched));
    }

    // A count, not a line number: a literal is the unit of work, and a line number would fail the gate
    // for any unrelated edit above one.
    private static List<string> Counts(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)))
            .Where(file => !IsRepositoryFile(root, file))
            .SelectMany(file => Occurrences(File.ReadAllText(file))
                .Select(o => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {o.Literal}: {o.Count}"))
            .Order(StringComparer.Ordinal)];

    // The same file name prefix elsewhere in the tree is not the repository: only Source itself is
    // exempt (ADR-0014 invariant 5).
    private static bool IsRepositoryFile(string root, string file) =>
        Path.GetFileName(file).StartsWith(RepositoryFilePrefix, StringComparison.Ordinal)
        && Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')
            .StartsWith(RepositoryFolder + "/", StringComparison.Ordinal);

    private static IEnumerable<(string Literal, int Count)> Occurrences(string text) =>
        Literals
            .Select(literal => (Literal: literal, Count: Regex.Count(text, Regex.Escape(literal))))
            .Where(o => o.Count > 0);
}
