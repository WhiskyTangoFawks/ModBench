using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class WriteSideIndexScanTests
{
    [Fact]
    public void TheScan_CountsPerFileAndSymbol_AndSkipsBuildOutputAndAnExcludedSubtree()
    {
        using var root = new ScratchDirectory("medit-write-side-index-scan-");
        Directory.CreateDirectory(Path.Combine(root, "Edits", "obj"));
        File.WriteAllText(
            Path.Combine(root, "Edits", "EditService.cs"),
            "IRecordReads reads = index.Reads!;\nvar rows = reads.Search(query);\n");
        File.WriteAllText(Path.Combine(root, "Edits", "Factory.cs"), "new DuckDbRecordIndexFactory();");
        File.WriteAllText(Path.Combine(root, "Edits", "obj", "Generated.cs"), "DuckDbRecordIndex index;");
        File.WriteAllText(Path.Combine(root, "Edits", "Clean.cs"), "repository.Put(plugin, document);");
        Directory.CreateDirectory(Path.Combine(root, "Records"));
        File.WriteAllText(Path.Combine(root, "Records", "Store.cs"), "DuckDbRecordIndex index;");

        var counts = Counts(root, [""], ["Records"], ["IRecordReads", "DuckDbRecordIndex", "DuckDbRecordIndexFactory"]);

        Assert.Equal(
            [
                "Edits/EditService.cs: IRecordReads: 1",
                "Edits/Factory.cs: DuckDbRecordIndexFactory: 1",
            ],
            counts);
    }

    private const string EndpointRoot = "MEditService.Http/Endpoints";

    private static readonly string[] UndrawnCallees = ["SourceRepository"];

    [Fact]
    public void NoEndpoint_NamesTheSourceRepository()
    {
        var root = ServiceProjects.SolutionDirectory();

        var walked = ScannedFiles(root, [EndpointRoot], []).Count;
        var named = Counts(root, [EndpointRoot], [], UndrawnCallees);

        Assert.True(walked > 5, $"The endpoint scan walked only {walked} files under {EndpointRoot}.");
        Assert.True(
            named.Count == 0,
            "An endpoint names the Source repository. Resolution under the load order is what the "
            + "Commands caption hides:\n"
            + string.Join("\n", named));
    }

    private static List<string> Counts(
        string root, IReadOnlyList<string> scannedRoots, string[] excludedRoots, string[] symbols) =>
        [.. ScannedFiles(root, scannedRoots, excludedRoots)
            .SelectMany(file => References(File.ReadAllText(file), symbols)
                .Select(r => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {r.Symbol}: {r.Count}"))
            .Order(StringComparer.Ordinal)];

    private static List<string> ScannedFiles(string root, IReadOnlyList<string> scannedRoots, string[] excludedRoots)
    {
        var excluded = excludedRoots
            .Select(r => Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar)) + Path.DirectorySeparatorChar)
            .ToList();

        return [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => !excluded.Exists(e => file.StartsWith(e, StringComparison.Ordinal)))];
    }

    private static IEnumerable<(string Symbol, int Count)> References(string text, string[] symbols) =>
        symbols
            .Select(symbol => (Symbol: symbol, Count: Regex.Count(text, $@"\b{symbol}\b")))
            .Where(r => r.Count > 0);
}
