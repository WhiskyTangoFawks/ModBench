using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>The write side names no Index type (ADR-0046 invariants 1, 4, 5 and 7). Editing, copy,
/// compile, Track, the external-change path and the repository write source text; what the Index
/// then holds is the projector's answer, asked for on the read side. References are counted against
/// an allowlist that stays empty.</summary>
public sealed class WriteSideIndexScanTests
{
    // The index and its factory, the read surface, the ref enum, the mirror, the projector, the
    // query surface and the store. Naming one is how a write path starts reading its own effect.
    private static readonly string[] Symbols =
    [
        "IRecordIndex", "IRecordIndexFactory", "DuckDbRecordIndex", "DuckDbRecordIndexFactory",
        "IRecordReads", "RecordRef", "ILoadOrderMirror", "LoadOrderMirror", "IndexProjector",
        "IQueryIndex", "IndexStore",
    ];

    // Everything under Edits, and Source but for the one file that is the Index's own reader.
    private static readonly string[] ScannedRoots =
        ["MEditService.Core/Edits", "MEditService.Core/Source"];

    /// <summary>Not write side: SourceIngest is how the Index reads a tracked tree, so the index it
    /// fills is its subject rather than a thing it consults mid-write.</summary>
    private const string IndexIngestFileName = "SourceIngest.cs";

    private const string AllowlistPath = "MEditService.Tests/Architecture/write-side-index-allowlist.txt";

    [Fact]
    public void TheWriteSide_NamesAnIndexType_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ArchitectureTests.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ScannedRoots),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    [Fact]
    public void TheScan_CountsPerFileAndSymbol_AndNamesANewReferenceAndADeletedOne()
    {
        var root = Directory.CreateTempSubdirectory("medit-write-side-index-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Edits", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Edits", "EditService.cs"),
                "IRecordReads reads = mirror.Reads!;\nvar rows = reads.At(RecordRef.Effective);\n");
            // The longer name is its own symbol: a prefix match would count it as the interface too.
            File.WriteAllText(Path.Combine(root, "Edits", "Factory.cs"), "new IRecordIndexFactory();");
            File.WriteAllText(Path.Combine(root, "Edits", "obj", "Generated.cs"), "IRecordIndex index;");
            File.WriteAllText(Path.Combine(root, "Edits", "Clean.cs"), "repository.Put(plugin, document);");
            Directory.CreateDirectory(Path.Combine(root, "Source"));
            File.WriteAllText(Path.Combine(root, "Source", IndexIngestFileName), "IRecordIndex index;");

            var counts = Counts(root, ["Edits", "Source"]);

            Assert.Equal(
                [
                    "Edits/EditService.cs: IRecordReads: 1",
                    "Edits/EditService.cs: RecordRef: 1",
                    "Edits/Factory.cs: IRecordIndexFactory: 1",
                ],
                counts);

            var newReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, ["Edits/Factory.cs: IRecordIndexFactory: 1"], AllowlistPath));
            Assert.Contains("Edits/EditService.cs: IRecordReads: 1", newReference.Message, StringComparison.Ordinal);

            var deletedReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [.. counts, "Edits/Gone.cs: IndexProjector: 4"], AllowlistPath));
            Assert.Contains("Edits/Gone.cs: IndexProjector: 4", deletedReference.Message, StringComparison.Ordinal);
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
            $"Index types named on the write side differ from {allowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — the write side writes source "
            + "text and reads nothing back from the Index, so a reference here needs the maintainer's "
            + "ruling before its line is added:\n"
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
            .Where(file => !Path.GetFileName(file).Equals(IndexIngestFileName, StringComparison.Ordinal))
            .SelectMany(file => References(File.ReadAllText(file))
                .Select(r => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {r.Symbol}: {r.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<(string Symbol, int Count)> References(string text) =>
        Symbols
            .Select(symbol => (Symbol: symbol, Count: Regex.Count(text, $@"\b{symbol}\b")))
            .Where(r => r.Count > 0);
}
