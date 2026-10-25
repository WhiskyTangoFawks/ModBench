using System.Text.RegularExpressions;
using System.Xml.Linq;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class InternalsVisibleToScanTests
{
    [Fact]
    public void NoProductionProject_GrantsInternalsVisibleTo()
    {
        var solution = ServiceProjects.SolutionDirectory();
        var grants = Grants(solution, ServiceProjects.Production(solution));

        Assert.True(
            grants.Count == 0,
            $"{grants.Count} InternalsVisibleTo grant(s) remain. Delete the grant, then drive the box "
            + "through its public interface; a test that cannot reach the behaviour from there is a "
            + "test of the wrong shape, and a behaviour the interface cannot reach is a design question "
            + "for the maintainer, never a grant:\n"
            + string.Join("\n", grants));
    }

    [Fact]
    public void TheScan_NamesAGrantInEveryFormTheBuildReads()
    {
        using var solution = new ScratchDirectory("medit-ivt-scan-");
        ScratchFiles.Plant(solution, "Directory.Build.props",
            "<Project><ItemGroup><InternalsVisibleTo Include=\"Everyone.Tests\" /></ItemGroup></Project>");
        ScratchFiles.Plant(solution, "Box/Box.csproj",
            "<Project><ItemGroup><InternalsVisibleTo Include=\"Box.Tests\" />"
            + "<AssemblyAttribute Include=\"System.Runtime.CompilerServices.InternalsVisibleTo\">"
            + "<_Parameter1>Box.Fakes</_Parameter1></AssemblyAttribute></ItemGroup></Project>");
        ScratchFiles.Plant(solution, "Box/AssemblyInfo.cs",
            "[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(\"Box.Probe\")]");

        Assert.Equal(
            [
                "Box.csproj grants internals to Box.Fakes",
                "Box.csproj grants internals to Box.Tests",
                "Box/AssemblyInfo.cs grants internals to Box.Probe",
                "Directory.Build.props grants internals to Everyone.Tests",
            ],
            Grants(solution, ["Box"]));
    }

    private static List<string> Grants(string solution, IReadOnlyList<string> projects) =>
        [.. MsBuildGrants(Path.Combine(solution, "Directory.Build.props"))
            .Concat(projects.SelectMany(project => MsBuildGrants(ServiceProjects.Csproj(solution, project))))
            .Concat(projects.SelectMany(project => SourceGrants(solution, project)))
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<string> MsBuildGrants(string msBuildFile)
    {
        var file = XDocument.Load(msBuildFile);
        var attributes = file.Descendants("AssemblyAttribute")
            .Where(attribute => (attribute.Attribute("Include")?.Value ?? string.Empty)
                .EndsWith("InternalsVisibleTo", StringComparison.Ordinal))
            .Select(attribute => attribute.Element("_Parameter1")?.Value ?? "(no _Parameter1)");
        var items = file.Descendants("InternalsVisibleTo")
            .Select(item => item.Attribute("Include")?.Value ?? "(no Include)");
        return attributes.Concat(items).Select(grantee => $"{Path.GetFileName(msBuildFile)} grants internals to {grantee}");
    }

    private static IEnumerable<string> SourceGrants(string solution, string project) =>
        SourceTree.CSharpFiles(ServiceProjects.Folder(solution, project))
            .SelectMany(file => Regex
                .Matches(File.ReadAllText(file), @"InternalsVisibleTo\s*\(\s*""([^""]*)""")
                .Select(match => $"{SourceTree.Relative(solution, file)} grants internals to {match.Groups[1].Value}"));
}
