using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class StoreNamespaceScanTests
{
    private const string StoreFolder = "MEditService.RecordIndex/Store/";

    private const string Root = "MEditService.RecordIndex/";

    private static readonly HashSet<string> Exemptions = new(StringComparer.Ordinal)
    {
        Root + "Queries/IndexAnswer.cs",
        Root + "FilterMatches.cs",
        Root + "RelationReads.cs",
    };

    [Fact]
    public void NothingOutsideTheStore_NamesDuckDb_BecauseTheStoreHidesIt()
    {
        var root = ServiceProjects.SolutionDirectory();

        var scanned = ServiceProjects.Production(root)
            .SelectMany(project => SourceTree.CSharpFiles(ServiceProjects.Folder(root, project)))
            .ToList();
        var named = NamingDuckDb(root, scanned);

        Assert.True(scanned.Count > 100, $"The Store scan walked only {scanned.Count} files.");
        Assert.True(
            named.Count == 0,
            "A .cs file outside RecordIndex/Store names DuckDB. The Store part hides it "
            + "(target-architecture.md § Maintaining):\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void EveryExemption_StillNamesDuckDb_SoTheListShrinksWithTheCode()
    {
        var root = ServiceProjects.SolutionDirectory();

        var stale = Exemptions
            .Where(relative => !File.ReadAllText(Path.Combine(root, relative)).Contains("duckdb", StringComparison.OrdinalIgnoreCase))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(stale.Count == 0, "These exemptions name no DuckDB; delete them:\n" + string.Join("\n", stale));
    }

    [Fact]
    public void TheScan_FlagsTheSubstringDuckdb_InAnyCase_AndSkipsTheStoreFolderAndBuildOutput()
    {
        using var root = new ScratchDirectory("medit-store-scan-");
        Directory.CreateDirectory(Path.Combine(root, "MEditService.RecordIndex", "Store"));
        Directory.CreateDirectory(Path.Combine(root, "Q", "obj"));
        File.WriteAllText(Path.Combine(root, "MEditService.RecordIndex", "Store", "Sql.cs"), "DuckDbSql.Execute();");
        File.WriteAllText(Path.Combine(root, "Q", "Reads.cs"), "using DuckDB.NET.Data;");
        File.WriteAllText(Path.Combine(root, "Q", "Comment.cs"), "// duckdb decides");
        File.WriteAllText(Path.Combine(root, "Q", "obj", "Generated.cs"), "DuckDBConnection c;");
        File.WriteAllText(Path.Combine(root, "Q", "Clean.cs"), "store.Read();");

        var files = SourceTree.CSharpFiles(root).ToList();

        Assert.Equal(["Q/Comment.cs", "Q/Reads.cs"], NamingDuckDb(root, files));
    }

    private static List<string> NamingDuckDb(string root, IEnumerable<string> files) =>
        [.. files
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(relative => !relative.StartsWith(StoreFolder, StringComparison.Ordinal))
            .Where(relative => !Exemptions.Contains(relative))
            .Where(relative => Regex.IsMatch(
                File.ReadAllText(Path.Combine(root, relative)), "duckdb", RegexOptions.IgnoreCase))
            .Order(StringComparer.Ordinal)];
}
