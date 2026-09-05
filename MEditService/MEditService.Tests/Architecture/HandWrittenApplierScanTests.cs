namespace MEditService.Tests.Architecture;

/// <summary>ADR-0032 rule 2: the codec is the one deserializer, so a hand-written applier is a
/// second one. The allowlist holds the sites that predate the rule; moving one onto the codec
/// deletes its line.</summary>
public sealed class HandWrittenApplierScanTests
{
    // One needle per move of the hand-written applier stack: build an object without its
    // constructor, set a property found by name, call a member found by name, close a generic by
    // hand.
    private static readonly string[] Needles =
        ["Activator.CreateInstance", ".SetValue(", ".Invoke(", "MakeGenericType"];

    // The editing stack: the schema layer that reflects the leaves and the edits layer that writes
    // them.
    private static readonly string[] ScannedRoots =
        [Path.Combine("MEditService.Core", "Schema"), Path.Combine("MEditService.Core", "Edits")];

    private const string AllowlistPath = "MEditService.Tests/Architecture/hand-written-applier-allowlist.txt";

    [Fact]
    public void EditingStack_HandWritesNoApplier_OutsideTheAllowlist()
    {
        var root = SolutionDirectory();
        var found = Sites(root);
        var allowed = File.ReadAllLines(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar)))
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && !l.StartsWith('#'))
            .ToList();

        var added = Excess(found, allowed);
        var gone = Excess(allowed, found);

        Assert.True(
            added.Count == 0 && gone.Count == 0,
            $"The editing stack's hand-written applier sites differ from {AllowlistPath}.\n"
            + $"Sites the allowlist does not name ({added.Count}) — the codec owns deserialization, "
            + "so a site here needs the maintainer's ruling before its line is added:\n"
            + string.Join("\n", added)
            + $"\nAllowlist lines matching no site ({gone.Count}) — delete them; the shrinking of this "
            + "list is what the work is measured by:\n"
            + string.Join("\n", gone));
    }

    [Fact]
    public void TheScan_ReachesTheApplierFilesItGuards()
    {
        var scanned = ScannedFiles(SolutionDirectory()).Select(Path.GetFileName).ToList();

        Assert.Contains("LeafWriters.cs", scanned, StringComparer.Ordinal);
        Assert.Contains("ListLeaves.cs", scanned, StringComparer.Ordinal);
        Assert.Contains("StructLeaves.cs", scanned, StringComparer.Ordinal);
        Assert.Contains("RecordFieldWriter.cs", scanned, StringComparer.Ordinal);
        Assert.Contains("ArrayOpWriter.cs", scanned, StringComparer.Ordinal);
    }

    // One line per site: the file and the source line, so a later change reads as which line went.
    // Line numbers are absent deliberately — they would fail the gate for any unrelated edit above
    // a site.
    private static List<string> Sites(string root) =>
        [.. ScannedFiles(root)
            .SelectMany(file => File.ReadLines(file)
                .Where(line => Needles.Any(n => line.Contains(n, StringComparison.Ordinal)))
                .Select(line => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {line.Trim()}"))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<string> ScannedFiles(string root) =>
        ScannedRoots
            .SelectMany(r => Directory.EnumerateFiles(Path.Combine(root, r), "*.cs", SearchOption.AllDirectories))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                     && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal);

    // Multiset difference: two sites can be the same line of the same file, and dropping one of
    // them has to fail the gate.
    private static List<string> Excess(IEnumerable<string> from, IEnumerable<string> subtract)
    {
        var remaining = subtract.GroupBy(l => l, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        var excess = new List<string>();
        foreach (var line in from)
        {
            if (remaining.TryGetValue(line, out var count) && count > 0) remaining[line] = count - 1;
            else excess.Add(line);
        }
        return excess;
    }

    private static string SolutionDirectory()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "MEditService.sln"))) return directory.FullName;
        }

        throw new InvalidOperationException("MEditService.sln not found above the test output directory.");
    }
}
