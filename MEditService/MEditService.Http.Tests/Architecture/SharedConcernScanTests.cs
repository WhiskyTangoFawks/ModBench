using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class SharedConcernScanTests
{
    private static readonly (string Concern, string Needle, string Module)[] ConcernMechanismNeedles =
    [
        ("target resolution", @"\.Get\(plugin, formKey, schemaReflector\b", "WriteTargets.cs"),
        ("FormKey allocation", @"\bHighRangeFormIdFloor\b", "FormKeyAllocator.cs"),
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
    public void NoTestFile_NamesASharedModule()
    {
        var root = ServiceProjects.SolutionDirectory();

        var hits = Directory.EnumerateDirectories(root, "MEditService.*Tests*")
            .SelectMany(SourceTree.CSharpFiles)
            .Where(file => !Path.GetFileName(file).Equals(nameof(SharedConcernScanTests) + ".cs", StringComparison.Ordinal))
            .Where(file => Regex.IsMatch(File.ReadAllText(file), @"\b(WriteTargets|FormKeyAllocator)\b"))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Empty(hits);
    }

    [Fact]
    public void TheScan_CountsPerFileAndNeedle_AndPassesTheModuleAndBuildOutput()
    {
        using var root = new ScratchDirectory("medit-shared-concern-scan-");
        Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
        File.WriteAllText(
            Path.Combine(root, "Layer", "Second.cs"),
            "found = repository.Get(plugin, formKey, schemaReflector.GetSchemas(release));\n"
            + "var floor = PluginFlagPredicates.HighRangeFormIdFloor(release);\n");
        File.WriteAllText(Path.Combine(root, "Layer", "WriteTargets.cs"), "repository.Get(plugin, id, schemaReflector.GetSchemas(release));");
        File.WriteAllText(Path.Combine(root, "Layer", "FormKeyAllocator.cs"), "var floor = PluginFlagPredicates.HighRangeFormIdFloor(release);");
        File.WriteAllText(Path.Combine(root, "Layer", "obj", "Generated.cs"), "repository.Get(plugin, formKey, schemaReflector.GetSchemas(release));");
        File.WriteAllText(Path.Combine(root, "Layer", "Clean.cs"), "repository.Put(plugin, document);");

        var counts = Counts(root, ["Layer"]);

        Assert.Equal(
            [
                @"Layer/Second.cs: \.Get\(plugin, formKey, schemaReflector\b: 1",
                @"Layer/Second.cs: \bHighRangeFormIdFloor\b: 1",
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
