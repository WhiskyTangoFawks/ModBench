using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>The write side's three shared concerns have one implementation each, in the module the
/// gestures share (ADR-0014). A gesture resolving its own target, rename or FormKey fails
/// here.</summary>
public sealed class SharedConcernScanTests
{
    // The mechanism each concern is made of, not the module's own method names: a handler calling
    // the module names the module, and only a second copy names these.
    private static readonly (string Concern, string Needle)[] Concerns =
    [
        ("target resolution", @"\bUnreadableDocumentFor\b"),
        ("FormKey allocation", @"\bHighRangeFormIdFloor\b"),
        ("FormKey allocation", @"\bFullIdMask\b"),
    ];

    // The gestures, the collaborators they write through, and the wire door above them.
    private static readonly string[] ScannedRoots =
        ["MEditService.Commands", "MEditService.Commands/Edits", "MEditService.Http"];

    // The module itself, which is where all four needles belong.
    private const string SharedModuleFileName = "WriteTargets.cs";

    // A second copy, not a second implementation: a resolver rebuilt from IdentityOf and Locate,
    // an allocator from Max()+1, or a rename from File.Move matches no needle here.
    [Fact]
    public void TheWriteSide_ImplementsNoSharedConcernItself()
    {
        var counts = Counts(ArchitectureTests.SolutionDirectory(), ScannedRoots);

        Assert.True(
            counts.Count == 0,
            "Shared concerns implemented outside the module — each is a second implementation of a "
            + "concern the gestures share:\n"
            + string.Join("\n", counts));
    }

    // A needle matching nothing anywhere would pass the scan above for the wrong reason, so each is
    // asserted against the module it was written from.
    [Fact]
    public void EveryNeedle_MatchesTheSharedModuleItself()
    {
        var module = File.ReadAllText(Path.Combine(
            ArchitectureTests.SolutionDirectory(), "MEditService.Commands", "Edits", SharedModuleFileName));

        Assert.Empty(Concerns.Where(c => Regex.Count(module, c.Needle) == 0).Select(c => $"{c.Concern}: {c.Needle}"));
    }

    // ADR-0014's testing decision: the module is internal and has no suite of its own, so the
    // gestures are its tests. A suite naming it is one testing it directly.
    [Fact]
    public void NoTestFile_NamesTheSharedModule()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var hits = Directory.EnumerateDirectories(root, "MEditService.*Tests*")
            .SelectMany(SourceTree.CSharpFiles)
            // A scan is not its own subject: this file names the module to scan for it.
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
                "if (repository.UnreadableDocumentFor(plugin, formKey) is { } why) return why;\n"
                + "var floor = PluginFlagPredicates.HighRangeFormIdFloor(release);\n");
            // The module's own file is what the counts are measured against, so it is not one of them.
            File.WriteAllText(Path.Combine(root, "Layer", SharedModuleFileName), "repository.UnreadableDocumentFor(plugin, id);");
            File.WriteAllText(Path.Combine(root, "Layer", "obj", "Generated.cs"), "repository.UnreadableDocumentFor(a, b);");
            File.WriteAllText(Path.Combine(root, "Layer", "Clean.cs"), "repository.Put(plugin, document);");

            var counts = Counts(root, ["Layer"]);

            Assert.Equal(
                [
                    @"Layer/Second.cs: \bHighRangeFormIdFloor\b: 1",
                    @"Layer/Second.cs: \bUnreadableDocumentFor\b: 1",
                ],
                counts);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // A count, not a line number: a reference is the unit of work, and a line number would fail the
    // gate for any unrelated edit above one.
    private static List<string> Counts(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => !Path.GetFileName(file).Equals(SharedModuleFileName, StringComparison.Ordinal))
            .SelectMany(file => References(File.ReadAllText(file))
                .Select(r => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {r.Needle}: {r.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<(string Needle, int Count)> References(string text) =>
        Concerns
            .Select(c => (c.Needle, Count: Regex.Count(text, c.Needle)))
            .Where(r => r.Count > 0);
}
