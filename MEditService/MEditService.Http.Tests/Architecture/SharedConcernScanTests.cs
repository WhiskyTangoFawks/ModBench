using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class SharedConcernScanTests
{
    private static readonly (string Concern, string Needle)[] ConcernMechanismNeedles =
    [
        ("target resolution", @"\.Get\(plugin, formKey, schemaReflector\b"),
        ("FormKey allocation", @"\bHighRangeFormIdFloor\b"),
        ("FormKey allocation", @"\bFullIdMask\b"),
    ];

    private static readonly string[] ScannedRoots =
        ["MEditService.Commands", "MEditService.Commands/Edits", "MEditService.Http"];

    private const string SharedModuleFileName = "WriteTargets.cs";

    [Fact]
    public void TheWriteSide_CarriesNoCopyOfASharedConcernsMechanism()
    {
        var counts = Counts(ArchitectureTests.SolutionDirectory(), ScannedRoots);

        Assert.True(
            counts.Count == 0,
            "Shared concerns implemented outside the module — each is a second implementation of a "
            + "concern the gestures share:\n"
            + string.Join("\n", counts));
    }

    [Fact]
    public void EveryNeedle_MatchesTheSharedModuleItself()
    {
        var module = File.ReadAllText(Path.Combine(
            ArchitectureTests.SolutionDirectory(), "MEditService.Commands", "Edits", SharedModuleFileName));

        Assert.Empty(ConcernMechanismNeedles.Where(c => Regex.Count(module, c.Needle) == 0).Select(c => $"{c.Concern}: {c.Needle}"));
    }

    [Fact]
    public void NoTestFile_NamesTheSharedModule()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var hits = Directory.EnumerateDirectories(root, "MEditService.*Tests*")
            .SelectMany(SourceTree.CSharpFiles)
            .Where(file => !Path.GetFileName(file).Equals(nameof(SharedConcernScanTests) + ".cs", StringComparison.Ordinal))
            .Where(file => Regex.IsMatch(File.ReadAllText(file), @"\bWriteTargets\b"))
            .Select(file => Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Empty(hits);
    }

    [Fact]
    public void TheScan_CountsPerFileAndNeedle_AndPassesTheModuleAndBuildOutput()
    {
        var root = Directory.CreateTempSubdirectory("medit-shared-concern-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Layer", "Second.cs"),
                "found = repository.Get(plugin, formKey, schemaReflector.GetSchemas(release));\n"
                + "var floor = PluginFlagPredicates.HighRangeFormIdFloor(release);\n");
            File.WriteAllText(Path.Combine(root, "Layer", SharedModuleFileName), "repository.Get(plugin, id, schemaReflector.GetSchemas(release));");
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
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static List<string> Counts(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => !Path.GetFileName(file).Equals(SharedModuleFileName, StringComparison.Ordinal))
            .SelectMany(file => References(File.ReadAllText(file))
                .Select(r => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {r.Needle}: {r.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<(string Needle, int Count)> References(string text) =>
        ConcernMechanismNeedles
            .Select(c => (c.Needle, Count: Regex.Count(text, c.Needle)))
            .Where(r => r.Count > 0);
}
