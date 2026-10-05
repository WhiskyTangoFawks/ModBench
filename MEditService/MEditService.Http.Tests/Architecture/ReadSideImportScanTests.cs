
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class ReadSideImportScanTests
{
    private const string ReadSideImport = "using MEditService.Queries;";

    private static readonly IReadOnlyList<string> ScannedRoots =
        [.. ServiceProjects.Production(ServiceProjects.SolutionDirectory())
            .Where(project => project is not ("MEditService.Http" or "MEditService.Queries"))];

    [Fact]
    public void NoKernelOrWriteSideFile_ImportsTheReadSide()
    {
        var importers = Importers(ServiceProjects.SolutionDirectory(), ScannedRoots);

        Assert.True(
            importers.Count == 0,
            "These files import the read side. The vocabulary they reach for belongs in the box that "
            + "owns it, so move the type rather than adding the import:\n"
            + string.Join("\n", importers));
    }

    [Fact]
    public void TheScan_NamesAnImportingFile_AndSkipsACleanOneAndBuildOutput()
    {
        var root = Directory.CreateTempSubdirectory("medit-read-side-import-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Schema", "obj"));
            File.WriteAllText(Path.Combine(root, "Schema", "Leaf.cs"), ReadSideImport + "\n");
            File.WriteAllText(Path.Combine(root, "Schema", "obj", "Generated.cs"), ReadSideImport + "\n");
            File.WriteAllText(Path.Combine(root, "Schema", "Clean.cs"), "using MEditService.Index;\n");

            Assert.Equal(["Schema/Leaf.cs"], Importers(root, ["Schema"]));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static List<string> Importers(string root, IReadOnlyList<string> scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => File.ReadAllText(file).Contains(ReadSideImport, StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)];
}
