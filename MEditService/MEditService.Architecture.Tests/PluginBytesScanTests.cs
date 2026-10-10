using System.Text.RegularExpressions;

namespace MEditService.Architecture.Tests;

public sealed class PluginBytesScanTests
{
    private static readonly IReadOnlyList<string> ProductionRoots =
        ServiceProjects.Production(ServiceProjects.SolutionDirectory());

    private const string AdapterRoot = "MEditService.PluginAdapter";

    private static readonly string[] ByteWalkNames = ["PluginBinaryWalk"];

    private const string CompositionRoot = "MEditService.Http/Program.cs";

    [Fact]
    public void NothingOutsideThePluginAdapter_WalksAPluginsBytes()
    {
        var root = ServiceProjects.SolutionDirectory();

        var walked = Files(root, ProductionRoots, [AdapterRoot]);
        var named = Sites(root, walked, ByteWalkNames);

        Assert.True(walked.Count > 50, $"The byte-walk scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A type outside the Plugin adapter walks a plugin's bytes. How a file differs at the byte "
            + "level is the answer of the Plugin adapter, which owns a plugin file (target-architecture.d2), so ask it:\n"
            + string.Join("\n", named));
    }

    [Fact]
    public void NothingButTheCompositionRoot_NamesTheAdaptersImplementation()
    {
        var root = ServiceProjects.SolutionDirectory();

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

    private static List<string> Files(string root, IReadOnlyList<string> scannedRoots, string[] excludedRoots)
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
