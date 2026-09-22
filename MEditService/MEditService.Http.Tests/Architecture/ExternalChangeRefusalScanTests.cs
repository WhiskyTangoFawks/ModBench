
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>The retired external-change button strings, modelled on <see cref="CarrierScanTests"/>,
/// so a comment, commit message, or fixture cannot regrow them under the wording the service now
/// composes.</summary>
public sealed class ExternalChangeRefusalScanTests
{
    // Needle data, not prose: the two button labels the extension retired, kept only so the scan
    // below can name a reference to them.
    private static readonly string[] RetiredStrings = ["Absorb Upstream Update", "Keep as My Edit"];

    private static readonly string[] ScannedRoots =
        ["MEditService.Codec", "MEditService.Commands", "MEditService.Http", "MEditService.Index",
         "MEditService.LoadOrder", "MEditService.PluginAdapter", "MEditService.Ports",
         "MEditService.Queries", "MEditService.SourceRepo", "MEditService.Watcher"];

    [Fact]
    public void TheEditingAndSourceStack_NeverNamesARetiredExternalChangeButtonString()
    {
        var root = ArchitectureTests.SolutionDirectory();

        Assert.Empty(Offenders(root, ScannedRoots));
    }

    // Proves the walk, not only the matcher: a planted file under a scanned root's own
    // subdirectory is found the same way a real one would be.
    [Fact]
    public void TheScan_FindsAPlantedRetiredStringUnderAScannedRoot()
    {
        var root = Directory.CreateTempSubdirectory("medit-external-change-refusal-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Layer"));
            File.WriteAllText(
                Path.Combine(root, "Layer", "Planted.cs"),
                "var refusal = \"Absorb Upstream Update or Keep as My Edit.\";\n");

            Assert.Equal(
                ["Layer/Planted.cs: Absorb Upstream Update", "Layer/Planted.cs: Keep as My Edit"],
                Offenders(root, ["Layer"]));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static List<string> Offenders(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)))
            .SelectMany(file => RetiredIn(File.ReadAllText(file))
                .Select(needle => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {needle}"))
            .Order(StringComparer.Ordinal)];

    private static List<string> RetiredIn(string text) => [.. RetiredStrings.Where(text.Contains)];
}
