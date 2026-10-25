using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class StoreNamespaceScanTests
{
    private const string StoreFolder = "MEditService.RecordIndex/Store/";

    [Fact]
    public void NothingOutsideTheStore_NamesDuckDb_BecauseTheStoreHidesIt()
    {
        var root = ServiceProjects.SolutionDirectory();

        var scanned = ServiceProjects.ProductionFiles(root);
        var named = NamingDuckDb(root, scanned);

        Assert.True(
            named.Count == 0,
            "A .cs file outside RecordIndex/Store names DuckDB. The Store part hides it "
            + "(target-architecture.md § Maintaining):\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void TheScan_FlagsTheSubstringDuckdb_InAnyCase_AndSkipsTheStoreFolder()
    {
        using var root = new ScratchDirectory("medit-store-scan-");
        ScratchFiles.Plant(root, "MEditService.RecordIndex/Store/Sql.cs", "DuckDbSql.Execute();");
        ScratchFiles.Plant(root, "Q/Reads.cs", "using DuckDB.NET.Data;");
        ScratchFiles.Plant(root, "Q/Comment.cs", "// duckdb decides");
        ScratchFiles.Plant(root, "Q/Clean.cs", "store.Read();");

        var files = SourceTree.CSharpFiles(root).ToList();

        Assert.Equal(["Q/Comment.cs", "Q/Reads.cs"], NamingDuckDb(root, files));
    }

    private static List<string> NamingDuckDb(string root, IEnumerable<string> files) =>
        [.. files
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(relative => !relative.StartsWith(StoreFolder, StringComparison.Ordinal))
            .Where(relative => Regex.IsMatch(
                File.ReadAllText(Path.Combine(root, relative)), "duckdb", RegexOptions.IgnoreCase))
            .Order(StringComparer.Ordinal)];
}
