using System.Xml.Linq;

namespace MEditService.Http.Tests.Architecture;

/// <summary>The service's projects as the gates read them from disk: a directory beside
/// MEditService.sln holding the csproj of the same name.</summary>
internal static class ServiceProjects
{
    internal static IReadOnlyList<string> All(string solutionDirectory) =>
        [.. Directory.EnumerateDirectories(solutionDirectory)
            .Select(Path.GetFileName)
            .OfType<string>()
            .Where(name => File.Exists(Csproj(solutionDirectory, name)))
            .Order(StringComparer.Ordinal)];

    internal static IReadOnlyList<string> Production(string solutionDirectory) =>
        [.. All(solutionDirectory).Where(project => !IsTestSide(project))];

    internal static IReadOnlyList<string> TestSide(string solutionDirectory) =>
        [.. All(solutionDirectory).Where(IsTestSide)];

    internal static bool IsTestSide(string project) =>
        project.Split('.').Any(segment => segment is "Tests" or "TestSupport");

    internal static string Csproj(string solutionDirectory, string project) =>
        Path.Combine(solutionDirectory, project, project + ".csproj");

    internal static string Folder(string solutionDirectory, string project) =>
        Path.Combine(solutionDirectory, project);

    internal static IReadOnlyList<string> ProjectReferences(string solutionDirectory, string project) =>
        [.. XDocument.Load(Csproj(solutionDirectory, project))
            .Descendants("ProjectReference")
            .Select(reference => reference.Attribute("Include")?.Value ?? string.Empty)
            .Select(include => include.Replace('\\', '/'))
            .Select(include => Path.GetFileNameWithoutExtension(include[(include.LastIndexOf('/') + 1)..]))
            .Where(name => name.Length > 0)
            .Order(StringComparer.Ordinal)];

    internal static string DocsArchitecture(string solutionDirectory)
    {
        var dir = new DirectoryInfo(solutionDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "docs", "architecture")))
            dir = dir.Parent;
        return dir is null
            ? throw new InvalidOperationException("docs/architecture not found above " + solutionDirectory)
            : Path.Combine(dir.FullName, "docs", "architecture");
    }
}
