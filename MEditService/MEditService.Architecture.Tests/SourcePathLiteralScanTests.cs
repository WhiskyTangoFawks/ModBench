using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class SourcePathLiteralScanTests
{
    private static readonly string[] LayoutLiteralsWithTheirQuotes =
        ["\"plugin-source\"", "\"RecordData.json\"", "\"GroupRecordData.json\"", "\".json\"",
         "\".git\"", "\"HEAD\"", "\"packed-refs\"", "\"refs\""];

    private static readonly IReadOnlyList<string> ScannedRoots =
        ServiceProjects.Production(ServiceProjects.SolutionDirectory());

    private const string RepositoryFilePrefix = "SourceRepository";
    private const string RepositoryFolder = "MEditService.SourceAdapter";

    private const string AllowlistPath = "MEditService.Architecture.Tests/source-path-allowlist.txt";

    [Fact]
    public void TheStackOutsideTheRepository_SpellsALayoutLiteral_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ServiceProjects.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ScannedRoots),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    [Fact]
    public void TheScan_PassesTheRepositorysOwnFiles_AndNamesALiteralPlantedElsewhere()
    {
        using var root = new ScratchDirectory("medit-source-path-scan-");
        ScratchFiles.Plant(root, "MEditService.SourceAdapter/SourceRepositoryLayout.cs",
            "internal const string RootFolderName = \"plugin-source\";\n"
            + "internal const string RecordDataFileName = \"RecordData.json\";\n");
        ScratchFiles.Plant(root, "Layer/EditService.cs",
            "var tree = Path.Combine(modFolder, \"plugin-source\", plugin);\n"
            + "var glob = Directory.EnumerateFiles(tree, \"*.json\");\n");
        ScratchFiles.Plant(root, "Layer/SourceRepositoryRival.cs", "internal const string Root = \"plugin-source\";");

        var counts = Counts(root, ["MEditService.SourceAdapter", "Layer"]);

        Assert.Equal(
            ["Layer/EditService.cs: \"plugin-source\": 1", "Layer/SourceRepositoryRival.cs: \"plugin-source\": 1"],
            counts);

        var unallowed = Assert.Throws<Xunit.Sdk.TrueException>(
            () => AssertCountsMatchAllowlist(counts, [], AllowlistPath));
        Assert.Contains("Layer/EditService.cs: \"plugin-source\": 1", unallowed.Message, StringComparison.Ordinal);
        Assert.Contains("Layer/SourceRepositoryRival.cs: \"plugin-source\": 1", unallowed.Message, StringComparison.Ordinal);

        var stale = Assert.Throws<Xunit.Sdk.TrueException>(
            () => AssertCountsMatchAllowlist(counts, [.. counts, "Layer/Gone.cs: \".json\": 2"], AllowlistPath));
        Assert.Contains("Layer/Gone.cs: \".json\": 2", stale.Message, StringComparison.Ordinal);
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

    private static List<string> Counts(string root, IReadOnlyList<string> scannedRoots) =>
        SourceTree.Sites(
            root,
            scannedRoots.SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r))).Where(file => !IsRepositoryFile(root, file)),
            [.. LayoutLiteralsWithTheirQuotes.Select(literal => (literal, new Regex(Regex.Escape(literal))))],
            File.ReadAllText);

    private static bool IsRepositoryFile(string root, string file) =>
        Path.GetFileName(file).StartsWith(RepositoryFilePrefix, StringComparison.Ordinal)
        && SourceTree.Relative(root, file).StartsWith(RepositoryFolder + "/", StringComparison.Ordinal);
}
