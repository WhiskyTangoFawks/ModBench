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
}
