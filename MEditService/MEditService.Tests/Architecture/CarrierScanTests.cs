using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>The source order carrier is gone: children live inline in their container's document
/// and no list carries order. Every reference to it is counted, and the allowlist is empty.</summary>
public sealed class CarrierScanTests
{
    // The carrier's own name, its drift rule, and the member it minted into a document.
    private static readonly string[] Symbols =
        ["SourceChildOrder", "SourceChildOrderDriftException", "MEditChildOrder"];

    private static readonly string[] ScannedRoots =
        ["MEditService.Core", "MEditService.Api", "MEditService.Bridge"];

    private const string AllowlistPath = "MEditService.Tests/Architecture/carrier-allowlist.txt";

    [Fact]
    public void TheEditingAndSourceStack_ReferencesTheCarrier_OnlyAsOftenAsTheAllowlistSays()
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
        var root = Directory.CreateTempSubdirectory("medit-carrier-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Layer", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Layer", "Carrier.cs"),
                "SourceChildOrder.SpliceInto(tree, mod);\nSourceChildOrder.ApplyTo(tree, mod);\n");
            // The longer name is its own symbol: a prefix match would count it as the carrier too.
            File.WriteAllText(Path.Combine(root, "Layer", "Drift.cs"), "throw new SourceChildOrderDriftException();");
            File.WriteAllText(Path.Combine(root, "Layer", "obj", "Generated.cs"), "SourceChildOrder.ApplyTo(tree, mod);");
            File.WriteAllText(Path.Combine(root, "Layer", "Clean.cs"), "var order = mod.Quests.First().DialogTopics;");

            var counts = Counts(root, ["Layer"]);

            Assert.Equal(
                ["Layer/Carrier.cs: SourceChildOrder: 2", "Layer/Drift.cs: SourceChildOrderDriftException: 1"],
                counts);

            var newReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, ["Layer/Drift.cs: SourceChildOrderDriftException: 1"], AllowlistPath));
            Assert.Contains("Layer/Carrier.cs: SourceChildOrder: 2", newReference.Message, StringComparison.Ordinal);

            var deletedReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [.. counts, "Layer/Gone.cs: MEditChildOrder: 4"], AllowlistPath));
            Assert.Contains("Layer/Gone.cs: MEditChildOrder: 4", deletedReference.Message, StringComparison.Ordinal);
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
            $"References to the source order carrier differ from {allowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — the carrier is on its way out, "
            + "so a reference here needs the maintainer's ruling before its line is added:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no count ({unmatched.Count}) — rewrite them to the counts above; "
            + "the emptying of this list is what the work is measured by:\n"
            + string.Join("\n", unmatched));
    }

    // A count, not a line number: a reference is the unit of work, and a line number would fail the
    // gate for any unrelated edit above one.
    private static List<string> Counts(string root, string[] scannedRoots) =>
        [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r)))
            .SelectMany(file => References(File.ReadAllText(file))
                .Select(r => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {r.Symbol}: {r.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<(string Symbol, int Count)> References(string text) =>
        Symbols
            .Select(symbol => (Symbol: symbol, Count: Regex.Count(text, $@"\b{symbol}\b")))
            .Where(r => r.Count > 0);
}
