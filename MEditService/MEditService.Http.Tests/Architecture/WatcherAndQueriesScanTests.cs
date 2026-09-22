using System.Text.RegularExpressions;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>Two captions the code contradicts: the Mod watcher announces nothing and tells the
/// Index and Commands, and Queries hide the Index's reads and draw no arrow to a store.</summary>
public sealed class WatcherAndQueriesScanTests
{
    private const string WatcherRoot = "MEditService.Watcher";

    private const string QueriesRoot = "MEditService.Queries";

    // The port and the verb it is held for: either one is a second answer to "what changed", beside
    // the read model's own.
    private static readonly (string Label, string Pattern)[] PublisherNeedles =
    [
        ("INotificationPublisher", @"\bINotificationPublisher\b"),
        (".Publish(", @"\.Publish\("),
    ];

    // Every spelling of the file system a core module reaches for. The three statics are anchored
    // against a member access, since a receiver's own Path or File property is the caller's data.
    private static readonly (string Label, string Pattern)[] FileSystemNeedles =
    [
        ("File.", @"(?<![\w.])File\."),
        ("Directory.", @"(?<![\w.])Directory\."),
        ("Path.", @"(?<![\w.])Path\."),
        ("FileStream", @"\bFileStream\b"),
        ("FileInfo", @"\bFileInfo\b"),
        ("DirectoryInfo", @"\bDirectoryInfo\b"),
        ("System.IO", @"\bSystem\.IO\b"),
    ];

    // ADR-0015 invariant 3: when a projection lands, the read model publishes which rows changed.
    // The watcher tells the Index and the Index announces, so a publish here is a second voice.
    [Fact]
    public void TheModWatcher_NamesNoNotificationPublisher()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, WatcherRoot);
        var named = Sites(root, walked, PublisherNeedles);

        Assert.Contains("ModFolderWatcher.cs", walked.Select(Path.GetFileName));
        Assert.True(
            named.Count == 0,
            "The Mod watcher publishes. It announces nothing and tells the Index and Commands, and "
            + "the read model is what says which rows changed and at which sequence (ADR-0015 "
            + "invariant 3):\n"
            + string.Join("\n", named));
    }

    // ADR-0014 invariant 1: the core knows no path and no byte format. Queries hide the Index's
    // reads, so a disk read here answers from a file the Index never saw.
    [Fact]
    public void Queries_NameNoFileSystem()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, QueriesRoot);
        var named = Sites(root, walked, FileSystemNeedles);

        Assert.True(walked.Count > 10, $"The Queries scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A query reads the disk. Queries hide the Index's reads and reach no system of record "
            + "(ADR-0014 invariant 1), so the answer comes from a row:\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void TheFileSystemScan_CountsPerFileAndSymbol_AndSkipsBuildOutputAndAMemberOfTheSameName()
    {
        var root = Directory.CreateTempSubdirectory("medit-queries-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Q", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Q", "Reads.cs"),
                "if (!File.Exists(p)) return;\nvar b = File.ReadAllBytes(p);\nvar d = Directory.GetFiles(p);\n");
            File.WriteAllText(Path.Combine(root, "Q", "Member.cs"), "var p = plugin.Path.Length;");
            File.WriteAllText(Path.Combine(root, "Q", "obj", "Generated.cs"), "File.Delete(p);");
            File.WriteAllText(Path.Combine(root, "Q", "Clean.cs"), "return index.Reads.At(key);");

            Assert.Equal(
                ["Q/Reads.cs: Directory.: 1", "Q/Reads.cs: File.: 2"],
                Sites(root, ScannedFiles(root, "Q"), FileSystemNeedles));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ThePublisherScan_CountsTheHeldPortAndTheCall_AndNotAnAnnounceOrAPublishedType()
    {
        var root = Directory.CreateTempSubdirectory("medit-watcher-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "W"));
            File.WriteAllText(
                Path.Combine(root, "W", "Holds.cs"),
                "private readonly INotificationPublisher _notifications;\n_notifications.Publish(new PluginChangedNotification(key));\n");
            // Telling the Index is the drawn arrow; the type's name travels in the Index's own call.
            File.WriteAllText(
                Path.Combine(root, "W", "Tells.cs"),
                "_index.Announce(() => _index.RefreshBinary(key, path));\nvar n = typeof(PluginChangedNotification);\n");

            Assert.Equal(
                ["W/Holds.cs: .Publish(: 1", "W/Holds.cs: INotificationPublisher: 1"],
                Sites(root, ScannedFiles(root, "W"), PublisherNeedles));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static List<string> ScannedFiles(string root, string scannedRoot) =>
        [.. SourceTree.CSharpFiles(Path.Combine(root, scannedRoot.Replace('/', Path.DirectorySeparatorChar)))];

    // A count, not a line number: a reference is the unit of work, and a line number would fail the
    // gate for any unrelated edit above one.
    private static List<string> Sites(
        string root, IEnumerable<string> files, (string Label, string Pattern)[] needles) =>
        [.. files
            .SelectMany(file => needles
                .Select(needle => (needle.Label, Count: Regex.Count(File.ReadAllText(file), needle.Pattern)))
                .Where(hit => hit.Count > 0)
                .Select(hit => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {hit.Label}: {hit.Count}"))
            .Order(StringComparer.Ordinal)];
}
