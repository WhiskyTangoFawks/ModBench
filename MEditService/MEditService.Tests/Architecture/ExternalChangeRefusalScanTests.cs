using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>The retired external-change button strings, modelled on <see cref="CarrierScanTests"/>,
/// so a comment, commit message, or fixture cannot regrow them under the wording the service now
/// composes.</summary>
public sealed class ExternalChangeRefusalScanTests
{
    // Needle data, not prose: the two button labels the extension retired, kept only so the scan
    // below can name a reference to them.
    private static readonly string[] RetiredStrings = ["Absorb Upstream Update", "Keep as My Edit"];

    private static readonly string[] ScannedRoots =
        ["MEditService.Core", "MEditService.Api", "MEditService.Bridge"];

    [Fact]
    public void TheEditingAndSourceStack_NeverNamesARetiredExternalChangeButtonString()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var offenders = ScannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)))
            .SelectMany(file => RetiredIn(File.ReadAllText(file))
                .Select(needle => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {needle}"))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Empty(offenders);
    }

    // Proves the matcher alone; the walk over Core/Api/Bridge is exercised by the test above.
    [Fact]
    public void TheScan_FindsBothPlantedRetiredStrings()
    {
        var dir = Directory.CreateTempSubdirectory("medit-external-change-refusal-scan-").FullName;
        try
        {
            var planted = Path.Combine(dir, "Planted.cs");
            File.WriteAllText(planted, "var refusal = \"Absorb Upstream Update or Keep as My Edit.\";\n");

            Assert.Equal(["Absorb Upstream Update", "Keep as My Edit"], RetiredIn(File.ReadAllText(planted)));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static List<string> RetiredIn(string text) => [.. RetiredStrings.Where(text.Contains)];
}
