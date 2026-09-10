using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>The kernel, the codec and the write side never import the read side (ADR-0046
/// invariants 1 and 3): an import here is a type filed in Queries that is not a read
/// model.</summary>
public sealed class ReadSideImportScanTests
{
    private const string ReadSideImport = "using MEditService.Core.Queries;";

    // The kernel's two boxes and the write side's two. Records is absent: the Index projects read
    // models, which is what the read side asks it for.
    private static readonly string[] ScannedRoots =
    [
        "MEditService.Core/Schema",
        "MEditService.Core/Edits",
        "MEditService.Core/Commands",
        "MEditService.Core/PluginAdapter",
        "MEditService.Core/Plugins",
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
            File.WriteAllText(Path.Combine(root, "Schema", "Clean.cs"), "using MEditService.Core.Records;\n");

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
