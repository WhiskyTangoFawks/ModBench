using MEditService.TestSupport.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>The kernel, the codec and the write side never import the read side (ADR-0014
/// invariants 1 and 3): an import here is a type filed in Queries that is not a read
/// model.</summary>
public sealed class ReadSideImportScanTests
{
    private const string ReadSideImport = "using MEditService.Queries;";

    // The kernel's three boxes, the write side, and the three driven adapters. Whole projects, so a
    // new folder in one joins the scan rather than sitting outside it.
    private static readonly string[] ScannedRoots =
    [
        "MEditService.Codec",
        "MEditService.LoadOrder",
        "MEditService.Ports",
        "MEditService.Commands",
        "MEditService.Index",
        "MEditService.PluginAdapter",
        "MEditService.SourceRepo",
    ];

    [Fact]
    public void NoKernelOrWriteSideFile_ImportsTheReadSide()
    {
        var importers = Importers(ArchitectureTests.SolutionDirectory(), ScannedRoots);

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

    private static List<string> Importers(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => File.ReadAllText(file).Contains(ReadSideImport, StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)];
}
