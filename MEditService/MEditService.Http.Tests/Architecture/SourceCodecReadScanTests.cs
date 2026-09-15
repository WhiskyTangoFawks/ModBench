using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>ADR-0014 invariant 1: a driven adapter reads the kernel for type facts and the
/// spelling of a layout level it mints, never for a record's content.</summary>
public sealed class SourceCodecReadScanTests
{
    // RecordTextCodec's members, minus BlankDocument, plus the bare type name: holding an instance
    // reaches every member without naming one. The lookahead excludes BlankDocument's own calls.
    private static readonly (string Name, Regex Pattern)[] ForbiddenMembers =
    [
        ("RecordTextCodec", new Regex(@"\bRecordTextCodec\b(?!\s*\.\s*BlankDocument\b)", RegexOptions.Compiled)),
        ("RoundTrip", new Regex(@"\bRoundTrip\b", RegexOptions.Compiled)),
        ("Deserialize", new Regex(@"\bDeserialize\b", RegexOptions.Compiled)),
        ("SerializeToText", new Regex(@"\bSerializeToText\b", RegexOptions.Compiled)),
        ("SerializeAndWrite", new Regex(@"\bSerializeAndWrite\b", RegexOptions.Compiled)),
        ("SerializeToBytesAsync", new Regex(@"\bSerializeToBytesAsync\b", RegexOptions.Compiled)),
        ("SerializeAsync", new Regex(@"\bSerializeAsync\b", RegexOptions.Compiled)),
        ("DeserializeAsync", new Regex(@"\bDeserializeAsync\b", RegexOptions.Compiled)),
        ("DeserializeFromBytesAsync", new Regex(@"\bDeserializeFromBytesAsync\b", RegexOptions.Compiled)),
        ("DeserializeEmptyAsync", new Regex(@"\bDeserializeEmptyAsync\b", RegexOptions.Compiled)),
        ("DeserializeTextAsync", new Regex(@"\bDeserializeTextAsync\b", RegexOptions.Compiled)),
        ("EmptyMajorRecord", new Regex(@"\bEmptyMajorRecord\b", RegexOptions.Compiled)),
    ];

    private static readonly string[] ScannedRoots = ["MEditService.SourceRepo"];

    private const string AllowlistPath = "MEditService.Http.Tests/Architecture/source-codec-read-allowlist.txt";

    [Fact]
    public void TheSourceFolder_TouchesACodecMember_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ArchitectureTests.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ScannedRoots),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    // An empty allowlist and zero references found are the same string: this is what tells them
    // apart, so a ScannedRoots typo that scans nothing cannot pass by matching nothing.
    [Fact]
    public void TheScan_WalksMoreThanFifteenProductionFiles()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, ScannedRoots).Count();

        Assert.True(walked > 15, $"The codec-read scan walked only {walked} files under {string.Join(", ", ScannedRoots)}.");
    }

    [Fact]
    public void TheScan_PermitsTypeDispatchAndBlankDocument_AndNamesAPlantedCodecReadOrWrite()
    {
        var root = Directory.CreateTempSubdirectory("medit-source-codec-read-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "MEditService.SourceRepo", "obj"));
            File.WriteAllText(
                Path.Combine(root, "MEditService.SourceRepo", "Permitted.cs"),
                "var folder = RecordTypeDispatch.For(release).FolderNameFor(recordType);\n"
                + "var minted = RecordTextCodec.BlankDocument(loquiType, release, identity);\n");
            File.WriteAllText(
                Path.Combine(root, "MEditService.SourceRepo", "Planted.cs"),
                "internal sealed class Reader\n{\n"
                + "    private readonly RecordTextCodec _codec = new(logger);\n"
                + "    internal string Read(IMajorRecordGetter record, GameRelease release) =>\n"
                + "        _codec.RoundTrip(text, release, null);\n}\n");
            File.WriteAllText(
                Path.Combine(root, "MEditService.SourceRepo", "obj", "Generated.cs"),
                "var codec = new RecordTextCodec(logger);\n");

            var counts = Counts(root, ["MEditService.SourceRepo"]);

            Assert.Equal(
                ["MEditService.SourceRepo/Planted.cs: RecordTextCodec: 1",
                 "MEditService.SourceRepo/Planted.cs: RoundTrip: 1"],
                counts);

            var unallowed = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [], AllowlistPath));
            Assert.Contains("MEditService.SourceRepo/Planted.cs: RecordTextCodec: 1", unallowed.Message, StringComparison.Ordinal);
            Assert.Contains("MEditService.SourceRepo/Planted.cs: RoundTrip: 1", unallowed.Message, StringComparison.Ordinal);
            Assert.Contains("RecordTypeDispatch", unallowed.Message, StringComparison.Ordinal);
            Assert.Contains("BlankDocument", unallowed.Message, StringComparison.Ordinal);

            var stale = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(
                    counts, [.. counts, "MEditService.SourceRepo/Gone.cs: SerializeAsync: 3"], AllowlistPath));
            Assert.Contains("MEditService.SourceRepo/Gone.cs: SerializeAsync: 3", stale.Message, StringComparison.Ordinal);
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
            "The Source folder touches a RecordTextCodec member outside its bound (ADR-0014 "
            + "invariant 1): a driven adapter reads the kernel for facts about types and for the "
            + "spelling of a layout level it mints, never for a record's content. Only "
            + "RecordTypeDispatch (type facts, not counted here) and RecordTextCodec.BlankDocument "
            + $"(the level it mints) are permitted; every other codec member differs from {allowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — read the type fact through "
            + "RecordTypeDispatch or mint through BlankDocument instead, or get the maintainer's "
            + "ruling before adding a line:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no count ({unmatched.Count}) — delete them; the shortening "
            + "of this list is what the work is measured by:\n"
            + string.Join("\n", unmatched));
    }

    // A count, not a line number: a touch is the unit of work, and a line number would fail the
    // gate for any unrelated edit above one.
    private static List<string> Counts(string root, string[] scannedRoots) =>
        [.. ScannedFiles(root, scannedRoots)
            .SelectMany(file => Occurrences(File.ReadAllText(file))
                .Select(o => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {o.Name}: {o.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<string> ScannedFiles(string root, string[] scannedRoots) =>
        scannedRoots.SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))));

    private static IEnumerable<(string Name, int Count)> Occurrences(string text) =>
        ForbiddenMembers
            .Select(member => (member.Name, Count: member.Pattern.Count(text)))
            .Where(o => o.Count > 0);
}
