using System.Text.RegularExpressions;
using System.Xml.Linq;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>A box's interface is its test surface: the captions in
/// docs/architecture/target-architecture.d2 are the interfaces, so no production project lets any
/// assembly past one.</summary>
public sealed class InternalsVisibleToScanTests
{
    [Fact]
    public void NoProductionProject_GrantsInternalsVisibleTo()
    {
        var solution = ArchitectureTests.SolutionDirectory();
        var projects = ServiceProjects.Production(solution);
        var grants = projects.SelectMany(project => Grants(solution, project)).ToList();

        Assert.True(
            projects.Count > 5,
            $"The InternalsVisibleTo scan found only {projects.Count} production project(s) beside "
            + "MEditService.sln — it is reading the wrong tree, so it would pass by finding nothing.");
        Assert.True(
            grants.Count == 0,
            $"{grants.Count} InternalsVisibleTo grant(s) remain. Delete the grant, then drive the box "
            + "through the interface its caption in docs/architecture/target-architecture.d2 names; a "
            + "test that cannot reach the behaviour from there is a test of the wrong shape, and a "
            + "behaviour the caption cannot express is a caption question for the maintainer, never a "
            + "grant:\n"
            + string.Join("\n", grants));
    }

    private static List<string> Grants(string solution, string project) =>
        [.. CsprojGrants(solution, project).Concat(SourceGrants(solution, project)).Order(StringComparer.Ordinal)];

    private static IEnumerable<string> CsprojGrants(string solution, string project) =>
        XDocument.Load(ServiceProjects.Csproj(solution, project))
            .Descendants("AssemblyAttribute")
            .Where(attribute => (attribute.Attribute("Include")?.Value ?? string.Empty)
                .EndsWith("InternalsVisibleTo", StringComparison.Ordinal))
            .Select(attribute => $"{project}.csproj grants internals to "
                + $"{attribute.Element("_Parameter1")?.Value ?? "(no _Parameter1)"}");

    private static IEnumerable<string> SourceGrants(string solution, string project) =>
        SourceTree.CSharpFiles(ServiceProjects.Folder(solution, project))
            .SelectMany(file => Regex
                .Matches(File.ReadAllText(file), @"InternalsVisibleTo\s*\(\s*""([^""]*)""")
                .Select(match => $"{Path.GetRelativePath(solution, file).Replace(Path.DirectorySeparatorChar, '/')}"
                    + $" grants internals to {match.Groups[1].Value}"));
}
