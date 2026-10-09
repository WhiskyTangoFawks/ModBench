using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class SharedConcernScanTests
{
    private static readonly (string Concern, string Needle, string Module)[] ConcernMechanismNeedles =
    [
        ("target resolution", @"\bnew (WriteTargets\.)?EditTarget\(", "WriteTargets.cs"),
        ("FormKey allocation", @"\bDefaultHighRangeFormID\b", "FormKeyAllocator.cs"),
        ("FormKey allocation", @"\bFullIdMask\b", "FormKeyAllocator.cs"),
    ];

    private static readonly string[] ScannedRoots =
        ["MEditService.Commands", "MEditService.Commands/Edits", "MEditService.Http"];

    [Fact]
    public void TheWriteSide_CarriesNoCopyOfASharedConcernsMechanism()
    {
        var counts = Counts(ServiceProjects.SolutionDirectory(), ScannedRoots);

        Assert.True(
            counts.Count == 0,
            "Shared concerns implemented outside the module — each is a second implementation of a "
            + "concern the gestures share:\n"
            + string.Join("\n", counts));
    }

    [Fact]
    public void EveryNeedle_MatchesTheSharedModuleItself()
    {
        var edits = Path.Combine(ServiceProjects.SolutionDirectory(), "MEditService.Commands", "Edits");

        Assert.Empty(ConcernMechanismNeedles
            .Where(c => Regex.Count(File.ReadAllText(Path.Combine(edits, c.Module)), c.Needle) == 0)
            .Select(c => $"{c.Concern}: {c.Needle}"));
    }

    [Fact]
    public void TheScan_CountsPerFileAndNeedle_AndPassesTheModuleAndBuildOutput()
    {
        using var root = new ScratchDirectory("medit-shared-concern-scan-");
        Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
        File.WriteAllText(
            Path.Combine(root, "Layer", "Second.cs"),
            "target = new WriteTargets.EditTarget(release, document.Identity, repository);\n"
            + "var floor = GameConstants.Get(release).DefaultHighRangeFormID;\n");
        File.WriteAllText(Path.Combine(root, "Layer", "WriteTargets.cs"), "target = new EditTarget(release, record, repository);");
        File.WriteAllText(Path.Combine(root, "Layer", "FormKeyAllocator.cs"), "var floor = GameConstants.Get(release).DefaultHighRangeFormID;");
        File.WriteAllText(Path.Combine(root, "Layer", "obj", "Generated.cs"), "target = new WriteTargets.EditTarget(release, document.Identity, repository);");
        File.WriteAllText(Path.Combine(root, "Layer", "Clean.cs"), "repository.Put(plugin, document);");

        var counts = Counts(root, ["Layer"]);

        Assert.Equal(
            [
                @"Layer/Second.cs: \bDefaultHighRangeFormID\b: 1",
                @"Layer/Second.cs: \bnew (WriteTargets\.)?EditTarget\(: 1",
            ],
            counts);
    }

    private static List<string> Counts(string root, IReadOnlyList<string> scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .SelectMany(file => References(Path.GetFileName(file), File.ReadAllText(file))
                .Select(r => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {r.Needle}: {r.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<(string Needle, int Count)> References(string fileName, string text) =>
        ConcernMechanismNeedles
            .Where(c => !c.Module.Equals(fileName, StringComparison.Ordinal))
            .Select(c => (c.Needle, Count: Regex.Count(text, c.Needle)))
            .Where(r => r.Count > 0);
}
