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

    // The repository itself, not just its doors: the tree door answers in documents, so where a tree
    // sits and how it is read are the repository's alone (#827's target architecture).
    private static readonly string[] RepositoryNames = ["SourceRepository"];

    private static readonly string[] PluginOpens = ["OpenForRead", "OpenForWrite", "CreateEmpty"];

    // The tree door's implementation and the seam its write takes: both are entered through the
    // port, so a caller naming either has reached past it.
    private static readonly string[] TreeDoorInternals = ["PluginTrees", "TreeDeserializer"];

    // The composition root names the implementation it builds, and nothing else does
    // (docs/architecture/target-architecture.md, "The pictures are the reference lists").
    private const string CompositionRoot = "MEditService.Api/Program.cs";

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
    public void NothingOutsideThePluginAdapter_NamesTheTreeDoorsImplementation()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = Files(root, ProductionRoots, [AdapterRoot]);
        var named = Sites(root, walked, TreeDoorInternals);

        Assert.True(walked.Count > 50, $"The tree-door scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A type outside the Plugin adapter names the tree door's implementation. Reading a source "
            + "tree into a mod and writing one back are the port's two members (ADR-0005 rule 2), so "
            + "ask the adapter:\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void NothingButTheCompositionRoot_NamesTheAdaptersImplementation()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = Files(root, ProductionRoots, [AdapterRoot]).Where(file => !IsCompositionRoot(root, file)).ToList();
        var named = Sites(root, walked, ["MutagenPluginAdapter"]);

        Assert.True(walked.Count > 50, $"The implementation scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A type outside the Plugin adapter names its implementation. Every caller takes the port, "
            + "and only the composition root names what it builds:\n"
            + string.Join("\n", named));

        var exempted = Sites(
            root, [Path.Combine(root, CompositionRoot.Replace('/', Path.DirectorySeparatorChar))],
            ["MutagenPluginAdapter"]);
        Assert.True(
            exempted.Count > 0,
            $"{CompositionRoot} names no implementation — delete the exemption rather than leaving it "
            + "pre-authorized.");
    }

    private static bool IsCompositionRoot(string root, string file) =>
        Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')
            .Equals(CompositionRoot, StringComparison.Ordinal);

    [Fact]
    public void ThePluginAdapter_NamesNoSourceRepository()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = Files(root, [AdapterRoot], []);
        var named = Sites(root, walked, RepositoryNames);

        Assert.True(walked.Count > 5, $"The adapter scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "The Plugin adapter names the Source repository. What a plugin holds is its own bytes' answer "
            + "(ADR-0015 invariant 5), and where a tree sits and how it is read are the repository's:\n"
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
