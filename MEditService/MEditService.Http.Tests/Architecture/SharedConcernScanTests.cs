using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>The write side's four shared concerns have one implementation each, in the module the
/// gestures share (ADR-0014). A gesture resolving its own target, deferral, rename or FormKey fails
/// here.</summary>
public sealed class SharedConcernScanTests
{
    // The mechanism each concern is made of, not the module's own method names: a handler calling
    // the module names the module, and only a second copy names these.
    private static readonly (string Concern, string Needle)[] Concerns =
    [
        ("target resolution", @"\bUnreadableDocumentFor\b"),
        ("the pre-write open-question check", @"\bSourceRepository\.UnansweredExternalChange\b"),
        ("rename on an EditorID change", @"\bRename\("),
        ("FormKey allocation", @"\bHighRangeFormIdFloor\b"),
        ("FormKey allocation", @"\bFullIdMask\b"),
    ];

    // The gestures, the collaborators they write through, and the wire door above them.
    private static readonly string[] ScannedRoots =
        ["MEditService.Commands", "MEditService.Commands/Edits", "MEditService.Http"];

    // The module itself, which is where all five needles belong.
    private const string SharedModuleFileName = "WriteTargets.cs";

    private const string AllowlistPath = "MEditService.Http.Tests/Architecture/shared-concern-allowlist.txt";

    // A second copy, not a second implementation: a resolver rebuilt from IdentityOf and Locate,
    // an allocator from Max()+1, or a rename from File.Move matches no needle here.
    [Fact]
    public void TheWriteSide_ImplementsASharedConcernItself_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ArchitectureTests.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ScannedRoots),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
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
    public void TheScan_CountsPerFileAndNeedle_AndNamesANewReferenceAndADeletedOne()
    {
        var root = Directory.CreateTempSubdirectory("medit-shared-concern-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Layer", "Second.cs"),
                "if (repository.UnreadableDocumentFor(plugin, formKey) is { } why) return why;\n"
                + "var floor = PluginFlagPredicates.HighRangeFormIdFloor(release);\n");
            File.WriteAllText(Path.Combine(root, "Layer", "Renamer.cs"), "repository.Rename(plugin, at, editorId);");
            // The module's own file is what the counts are measured against, so it is not one of them.
            File.WriteAllText(Path.Combine(root, "Layer", SharedModuleFileName), "repository.Rename(plugin, at, id);");
            File.WriteAllText(Path.Combine(root, "Layer", "obj", "Generated.cs"), "repository.Rename(a, b, c);");
            File.WriteAllText(Path.Combine(root, "Layer", "Clean.cs"), "repository.Put(plugin, document);");

            var counts = Counts(root, ["Layer"]);

            Assert.Equal(
                [
                    @"Layer/Renamer.cs: \bRename\(: 1",
                    @"Layer/Second.cs: \bHighRangeFormIdFloor\b: 1",
                    @"Layer/Second.cs: \bUnreadableDocumentFor\b: 1",
                ],
                counts);

            var newReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [@"Layer/Renamer.cs: \bRename\(: 1"], AllowlistPath));
            Assert.Contains(@"Layer/Second.cs: \bUnreadableDocumentFor\b: 1", newReference.Message, StringComparison.Ordinal);

            var deletedReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [.. counts, @"Layer/Gone.cs: \bFullIdMask\b: 4"], AllowlistPath));
            Assert.Contains(@"Layer/Gone.cs: \bFullIdMask\b: 4", deletedReference.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertCountsMatchAllowlist(
        IReadOnlyList<string> counts, IReadOnlyList<string> allowlist, string allowlistPath)
    {
        var unallowed = counts.Except(allowlist, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var unmatched = allowlist.Except(counts, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();

        Assert.True(
            unallowed.Count == 0 && unmatched.Count == 0,
            $"Shared concerns implemented outside the module differ from {allowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — each is a second implementation "
            + "of a concern the gestures share, so it needs the maintainer's ruling before its line is "
            + "added:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no count ({unmatched.Count}) — delete them; this list is empty "
            + "and stays empty:\n"
            + string.Join("\n", unmatched));
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
