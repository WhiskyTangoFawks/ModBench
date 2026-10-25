using System.Text.RegularExpressions;

namespace MEditService.Architecture.Tests;

/// <summary>The repository's own C# source, for the guards that scan text rather than metadata:
/// build output is generated, so a needle found there names nobody.</summary>
public static class SourceTree
{
    public static IEnumerable<string> CSharpFiles(string root) => Files(root, "*.cs");

    public static IEnumerable<string> Files(string root, string pattern) =>
        Directory.EnumerateFiles(root, pattern, SearchOption.AllDirectories)
            .Where(file => !Path.GetRelativePath(root, file).Split(Path.DirectorySeparatorChar).Any(segment => segment is "obj" or "bin"));

    public static string Relative(string root, string file) =>
        Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/');

    public static List<string> Sites(
        string root, IEnumerable<string> files, IReadOnlyList<(string Label, Regex Pattern)> needles, Func<string, string> textOf) =>
        [.. files
            .SelectMany(file => textOf(file) is var text
                ? needles
                    .Select(needle => (needle.Label, Count: needle.Pattern.Count(text)))
                    .Where(hit => hit.Count > 0)
                    .Select(hit => $"{Relative(root, file)}: {hit.Label}: {hit.Count}")
                : [])
            .Order(StringComparer.Ordinal)];

    public static IReadOnlyList<string> ReadAllowlist(string path) =>
        [.. File.ReadAllLines(path).Select(line => line.Trim()).Where(line => line.Length > 0 && !line.StartsWith('#'))];
}
