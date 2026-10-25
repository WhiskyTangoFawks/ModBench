using System.Text.RegularExpressions;

namespace MEditService.Architecture.Tests;

public sealed class PluginAdapterImplementationScanTests
{
    private const string AdapterRoot = "MEditService.PluginAdapter";

    private const string CompositionRoot = "MEditService.Http/Program.cs";

    private static readonly (string, Regex)[] TheAdaptersImplementation =
        [("MutagenPluginAdapter", new Regex(@"\bMutagenPluginAdapter\b"))];

    [Fact]
    public void NothingButTheCompositionRoot_NamesTheAdaptersImplementation()
    {
        var root = ServiceProjects.SolutionDirectory();

        var walked = ServiceProjects.Production(root)
            .Where(project => project != AdapterRoot)
            .SelectMany(project => SourceTree.CSharpFiles(ServiceProjects.Folder(root, project)))
            .Where(file => SourceTree.Relative(root, file) != CompositionRoot)
            .ToList();
        var named = SourceTree.Sites(root, walked, TheAdaptersImplementation, File.ReadAllText);

        Assert.True(walked.Count > 50, $"The implementation scan walked only {walked.Count} files.");
        Assert.True(
            named.Count == 0,
            "A type outside the Plugin adapter names its implementation. Every caller takes the port, "
            + "and only the composition root names what it builds:\n"
            + string.Join("\n", named));

        var exempted = SourceTree.Sites(
            root, [Path.Combine(root, CompositionRoot.Replace('/', Path.DirectorySeparatorChar))],
            TheAdaptersImplementation, File.ReadAllText);
        Assert.True(
            exempted.Count > 0,
            $"{CompositionRoot} names no implementation — delete the exemption rather than leaving it "
            + "pre-authorized.");
    }
}
