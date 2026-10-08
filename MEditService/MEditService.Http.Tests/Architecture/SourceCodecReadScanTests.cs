using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class SourceCodecReadScanTests
{
    private static readonly (string Name, Regex Pattern)[] ForbiddenMembersAndTheBareTypeName =
    [
        ("RecordTextCodec", new Regex(@"\bRecordTextCodec\b(?!\s*\.\s*BlankDocument\b)", RegexOptions.Compiled)),
        ("RoundTrip", new Regex(@"\bRoundTrip\b", RegexOptions.Compiled)),
        ("Deserialize", new Regex(@"\bDeserialize\b", RegexOptions.Compiled)),
        ("SerializeToText", new Regex(@"\bSerializeToText\b", RegexOptions.Compiled)),
        ("DeserializeEmpty", new Regex(@"\bDeserializeEmpty\b", RegexOptions.Compiled)),
        ("DeserializeText", new Regex(@"\bDeserializeText\b", RegexOptions.Compiled)),
        ("EmptyMajorRecord", new Regex(@"\bEmptyMajorRecord\b", RegexOptions.Compiled)),
    ];

    private static readonly string[] ScannedRoots = ["MEditService.SourceAdapter"];

    [Fact]
    public void TheSourceFolder_TouchesNoCodecMemberButBlankDocument()
    {
        var counts = Counts(ServiceProjects.SolutionDirectory(), ScannedRoots);

        Assert.True(
            counts.Count == 0,
            "The Source folder touches a RecordTextCodec member outside its bound; the Codec owns a record as text and as document (target-architecture.d2): "
            + "a repository reads the kernel for facts about types and for the "
            + "spelling of a layout level it mints, never for a record's content. Only "
            + "RecordTypes (type facts, not counted here) and RecordTextCodec.BlankDocument "
            + "(the level it mints) are permitted — read the type fact through RecordTypes or "
            + "mint through BlankDocument instead:\n"
            + string.Join("\n", counts));
    }

    [Fact]
    public void TheScan_WalksMoreThanFifteenProductionFiles()
    {
        var root = ServiceProjects.SolutionDirectory();

        var walked = ScannedFiles(root, ScannedRoots).Count();

        Assert.True(walked > 15, $"The codec-read scan walked only {walked} files under {string.Join(", ", ScannedRoots)}.");
    }

    [Fact]
    public void TheScan_PermitsTypeDispatchAndBlankDocument_AndNamesAPlantedCodecReadOrWrite()
    {
        using var root = new ScratchDirectory("medit-source-codec-read-scan-");
        Directory.CreateDirectory(Path.Combine(root, "MEditService.SourceAdapter", "obj"));
        File.WriteAllText(
            Path.Combine(root, "MEditService.SourceAdapter", "Permitted.cs"),
            "var folder = RecordTypes.For(release).FolderNameFor(recordType);\n"
            + "var minted = RecordTextCodec.BlankDocument(level, release, identity);\n");
        File.WriteAllText(
            Path.Combine(root, "MEditService.SourceAdapter", "Planted.cs"),
            "internal static class Reader\n{\n"
            + "    internal static string Read(string text, GameRelease release) =>\n"
            + "        RecordTextCodec.RoundTrip(text, release, null);\n}\n");
        File.WriteAllText(
            Path.Combine(root, "MEditService.SourceAdapter", "obj", "Generated.cs"),
            "var text = RecordTextCodec.RoundTrip(text, release, null);\n");

        var counts = Counts(root, ["MEditService.SourceAdapter"]);

        Assert.Equal(
            ["MEditService.SourceAdapter/Planted.cs: RecordTextCodec: 1",
             "MEditService.SourceAdapter/Planted.cs: RoundTrip: 1"],
            counts);
    }

    private static List<string> Counts(string root, IReadOnlyList<string> scannedRoots) =>
        [.. ScannedFiles(root, scannedRoots)
            .SelectMany(file => Occurrences(File.ReadAllText(file))
                .Select(o => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {o.Name}: {o.Count}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<string> ScannedFiles(string root, IReadOnlyList<string> scannedRoots) =>
        scannedRoots.SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))));

    private static IEnumerable<(string Name, int Count)> Occurrences(string text) =>
        ForbiddenMembersAndTheBareTypeName
            .Select(member => (member.Name, Count: member.Pattern.Count(text)))
            .Where(o => o.Count > 0);
}
