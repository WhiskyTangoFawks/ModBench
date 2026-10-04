namespace MEditService.Http.Tests.Architecture;

public sealed class TestProjectReferenceScanTests
{
    private const string TestSupport = "MEditService.TestSupport";
    private const string PluginAdapter = "MEditService.PluginAdapter";
    private static readonly string[] Kernel = ["MEditService.Codec", "MEditService.LoadOrder", "MEditService.Ports"];

    [Fact]
    public void EveryTestSideProject_ReferencesItsBoxWhatTheBoxReferencesAndTestSupport()
    {
        var solution = ArchitectureTests.SolutionDirectory();
        var violations = new List<string>();

        foreach (var project in ServiceProjects.TestSide(solution))
        {
            var required = Required(solution, project);
            if (required is null)
            {
                violations.Add($"{project}: no box owns it. A test project is one box's caller, named "
                    + "<box>.Tests; move each test into the project of the box whose interface it "
                    + "drives, then delete this project.");
                continue;
            }

            var actual = ServiceProjects.ProjectReferences(solution, project).ToHashSet(StringComparer.Ordinal);
            var missing = required.Where(r => !actual.Contains(r)).ToList();
            var extra = actual.Where(a => !required.Contains(a) && a != TestSupport)
                .Order(StringComparer.Ordinal).ToList();
            if (missing.Count > 0 || extra.Count > 0)
            {
                violations.Add($"{project}: "
                    + (extra.Count > 0 ? $"remove {string.Join(", ", extra)}; " : string.Empty)
                    + (missing.Count > 0 ? $"add {string.Join(", ", missing)}; " : string.Empty)
                    + $"the list is {string.Join(", ", required)}, plus {TestSupport} where it is used.");
            }
        }

        Assert.True(
            violations.Count == 0,
            $"{violations.Count} test-side project(s) reference something its box does not, or miss "
            + "something it does. A test project is its box's caller: it references the box, what the "
            + "box references, and TestSupport where it is used:\n"
            + string.Join("\n", violations));
    }

    [Fact]
    public void TheScan_SeesEveryBoxAndItsTestProject()
    {
        var solution = ArchitectureTests.SolutionDirectory();
        var boxes = ServiceProjects.Production(solution);
        var untested = boxes.Where(box => !File.Exists(ServiceProjects.Csproj(solution, box + ".Tests"))).ToList();

        Assert.True(boxes.Count > 5, $"The scan found only {boxes.Count} production project(s) beside MEditService.sln.");
        Assert.True(untested.Count == 0, "A box with no test project: " + string.Join(", ", untested));
    }

    private static SortedSet<string>? Required(string solution, string project)
    {
        if (project == TestSupport)
            return [.. Kernel, PluginAdapter];
        if (!project.EndsWith(".Tests", StringComparison.Ordinal))
            return null;

        var box = project[..^".Tests".Length];
        if (!File.Exists(ServiceProjects.Csproj(solution, box)))
            return null;

        return [box, .. ServiceProjects.ProjectReferences(solution, box)];
    }
}
