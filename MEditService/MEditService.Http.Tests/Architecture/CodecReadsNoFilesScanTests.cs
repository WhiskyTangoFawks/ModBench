using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class CodecReadsNoFilesScanTests
{
    private const string CodecRoot = "MEditService.Codec";

    private static readonly string[] FileSystemNames =
        [@"File\.", @"Directory\.", "ModPath", "RecordLocator", @"CreateTempSubdirector[y]"];

    [Fact]
    public void TheCodec_NamesNoFileSystemAndNoPluginPath()
    {
        var root = ServiceProjects.SolutionDirectory();
        var files = SourceTree.CSharpFiles(Path.Combine(root, CodecRoot)).ToList();

        var named = files
            .SelectMany(file => FileSystemNames
                .Select(pattern => (Pattern: pattern, Count: Regex.Count(CodeOf(file), $@"\b{pattern}")))
                .Where(hit => hit.Count > 0)
                .Select(hit => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {hit.Pattern}: {hit.Count}"))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(files.Count > 10, $"The Codec scan walked only {files.Count} files.");
        Assert.True(
            named.Count == 0,
            "The Codec names a file system call or a plugin path. It turns text into documents and back and reads "
            + "no file; what a plugin file holds is the Plugin adapter's answer (ADR-0004, ADR-0014):\n"
            + string.Join("\n", named));
    }

    private static string CodeOf(string file) =>
        string.Join('\n', File.ReadAllLines(file).Select(line => Regex.Replace(line, "//.*$", "")));
}
