using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>ADR-0005 rule 2 in both directions: a plugin's bytes are opened only inside the Plugin
/// adapter, and the adapter answers from bytes, never from a source tree (ADR-0015 invariant 5).</summary>
public sealed class PluginBytesScanTests
{
    private static readonly string[] ProductionRoots =
        ["MEditService.Core", "MEditService.Api", "MEditService.Bridge"];

    private const string AdapterRoot = "MEditService.Core/PluginAdapter";

    // Holding a repository is how a reader starts answering from a tree; the layout spellings it
    // also exposes are constants, and name no content.
    private static readonly string[] RepositoryOpens = [@"SourceRepository\.Open", @"SourceRepository\.Over"];

    private static readonly string[] PluginOpens = ["OpenForRead", "OpenForWrite"];

    [Fact]
    public void NothingOutsideThePluginAdapter_OpensAPlugin()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = Files(root, ProductionRoots, [AdapterRoot]);
        var named = Sites(root, walked, PluginOpens);

        Assert.True(walked.Count > 50, $"The plugin-open scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A type outside the Plugin adapter opens a plugin file. A live Mutagen mod reaches nothing "
            + "but the codec and the Plugin adapter (ADR-0005 rule 2), so ask the adapter for the "
            + "answer as data instead:\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void ThePluginAdapter_OpensNoSourceRepository()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = Files(root, [AdapterRoot], []);
        var named = Sites(root, walked, RepositoryOpens);

        Assert.True(walked.Count > 5, $"The adapter scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "The Plugin adapter reads a source tree. What a plugin holds is its own bytes' answer "
            + "(ADR-0015 invariant 5), and the tree is the write side's to read:\n"
            + string.Join("\n", named));
    }

    private static List<string> Files(string root, string[] scannedRoots, string[] excludedRoots)
    {
        var excluded = excludedRoots
            .Select(r => Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar)) + Path.DirectorySeparatorChar)
            .ToList();

        return [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => !excluded.Exists(e => file.StartsWith(e, StringComparison.Ordinal)))];
    }

    private static List<string> Sites(string root, IEnumerable<string> files, string[] patterns) =>
        [.. files
            .SelectMany(file => patterns
                .Select(pattern => (Pattern: pattern, Count: Regex.Count(File.ReadAllText(file), $@"\b{pattern}\b")))
                .Where(hit => hit.Count > 0)
                .Select(hit => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {hit.Pattern}: {hit.Count}"))
            .Order(StringComparer.Ordinal)];
}
