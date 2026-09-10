namespace MEditService.Tests.TestSupport;

/// <summary>The repository's own C# source, for the guards that scan text rather than metadata:
/// build output is generated, so a needle found there names nobody.</summary>
internal static class SourceTree
{
    internal static IEnumerable<string> CSharpFiles(string root) =>
        Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories).Where(IsNotBuildOutput);

    internal static IEnumerable<string> MarkdownFiles(string root) =>
        Directory.EnumerateFiles(root, "*.md", SearchOption.AllDirectories).Where(IsNotBuildOutput);

    internal static bool IsNotBuildOutput(string file) =>
        !file.Split(Path.DirectorySeparatorChar).Any(segment => segment is "obj" or "bin");

    internal static IReadOnlyList<string> ReadAllowlist(string path) =>
        [.. File.ReadAllLines(path).Select(line => line.Trim()).Where(line => line.Length > 0 && !line.StartsWith('#'))];

    // A scan site carries no line number, so two sites can be the same text in the same file: an
    // allowlist line covers one of them rather than all.
    internal static List<string> NotCoveredBy(IEnumerable<string> lines, IEnumerable<string> cover)
    {
        var available = cover.GroupBy(l => l, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        var uncovered = new List<string>();
        foreach (var line in lines)
        {
            if (available.TryGetValue(line, out var count) && count > 0) available[line] = count - 1;
            else uncovered.Add(line);
        }
        return uncovered;
    }
}
