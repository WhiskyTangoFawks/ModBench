using System.Text.RegularExpressions;

namespace MEditService.Http.Tests.Architecture;

/// <summary>A test project is a caller. Its references are its box, the arrows the reference view
/// draws from its box, the kernel by the band rule, and test support; the arrows are read from the
/// d2.</summary>
public sealed class TestProjectReferenceScanTests
{
    private const string TestSupport = "MEditService.TestSupport";
    private const string PluginAdapter = "MEditService.PluginAdapter";
    private const string Ports = "medit_kernel.ports";
    private const string LoadOrder = "MEditService.LoadOrder";
    private const string CompositionRoot = "medit_driving.http";
    private const string KernelBand = "medit_kernel";

    // The reference view names boxes, the solution names projects; this is that naming and nothing
    // more. What each box reaches is read from the d2.
    private static readonly Dictionary<string, string> BoxOfProject = new(StringComparer.Ordinal)
    {
        ["MEditService.Http"] = CompositionRoot,
        ["MEditService.Watcher"] = "medit_driving.watcher",
        ["MEditService.Commands"] = "medit_core.commands",
        ["MEditService.Queries"] = "medit_core.queries",
        ["MEditService.Index"] = "medit_driven.index",
        ["MEditService.SourceRepo"] = "medit_driven.sourcerepo",
        [PluginAdapter] = "medit_driven.pluginadapter",
        [LoadOrder] = "medit_kernel.loadorder",
        ["MEditService.Codec"] = "medit_kernel.codec",
        ["MEditService.Ports"] = Ports,
    };

    [Fact]
    public void EveryTestSideProject_ReferencesItsBoxTheArrowsTheKernelAndTestSupport()
    {
        var solution = ArchitectureTests.SolutionDirectory();
        var arrows = ReachedProjects(RefArrows(solution));
        var violations = new List<string>();

        foreach (var project in ServiceProjects.TestSide(solution))
        {
            var required = Required(solution, project, arrows);
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
            $"{violations.Count} test-side project(s) reference something the reference view does not "
            + "draw, or miss something it does. A reference the picture does not draw is a question "
            + "for the maintainer, never a line to add to the csproj:\n"
            + string.Join("\n", violations));
    }

    // An arrow set that parsed to nothing would make every expected list the kernel alone, and the
    // gate would pass by measuring nothing.
    [Fact]
    public void TheArrowParse_ReadsTheReferenceViewAndFindsEveryBoxOutsideTheKernel()
    {
        var arrows = RefArrows(ArchitectureTests.SolutionDirectory());
        var drawn = arrows.SelectMany(arrow => new[] { arrow.From, arrow.To }).ToHashSet(StringComparer.Ordinal);
        var absent = BoxOfProject.Values
            .Where(box => !box.StartsWith(KernelBand, StringComparison.Ordinal) && !drawn.Contains(box))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(
            arrows.Count > 20,
            $"The arrow parse matched {arrows.Count} reference arrow(s) in "
            + "docs/architecture/target-architecture-references.d2 — the `a -> b {class: ref}` lines "
            + "are shaped otherwise now, so every expected reference list is wrong.");
        Assert.True(
            absent.Count == 0,
            "The reference view draws no arrow at all touching " + string.Join(", ", absent)
            + " — the box was renamed in the d2 and BoxOfProject still names the old id, so its "
            + "expected reference list silently became the kernel alone.");
    }

    private static SortedSet<string>? Required(
        string solution, string project, Dictionary<string, List<string>> arrows)
    {
        if (project == TestSupport)
            return [.. Kernel(), PluginAdapter];
        if (!project.EndsWith(".Tests", StringComparison.Ordinal))
            return null;

        var box = project[..^".Tests".Length];
        if (!BoxOfProject.TryGetValue(box, out var id))
            return null;

        SortedSet<string> required = [box, .. arrows.TryGetValue(id, out var reached) ? reached : []];

        // The band rule: the kernel is "read by every Core box and driven adapter"; a driving
        // adapter's kernel arrows are drawn, and inside the kernel "Ports reads Load order state;
        // nothing else in the kernel references anything".
        if (id.StartsWith("medit_core", StringComparison.Ordinal)
            || id.StartsWith("medit_driven", StringComparison.Ordinal))
            required.UnionWith(Kernel());
        if (id == Ports) required.Add(LoadOrder);

        // "A composition root ... references every box below it by definition."
        if (id == CompositionRoot)
            required.UnionWith(ServiceProjects.Production(solution).Where(p => p != box));

        return required;
    }

    private static IEnumerable<string> Kernel() =>
        BoxOfProject.Where(pair => pair.Value.StartsWith(KernelBand, StringComparison.Ordinal))
            .Select(pair => pair.Key);

    // The d2 grammar resists a general parse, so only the arrow lines are read.
    private static List<(string From, string To)> RefArrows(string solution) =>
        [.. Regex.Matches(
                File.ReadAllText(Path.Combine(
                    ServiceProjects.DocsArchitecture(solution), "target-architecture-references.d2")),
                @"^([A-Za-z_][\w.]*)\s*->\s*([A-Za-z_][\w.]*)\s*\{([^}]*)\}\s*$",
                RegexOptions.Multiline)
            .Where(arrow => Regex.IsMatch(arrow.Groups[3].Value, @"\bclass:\s*ref\b"))
            .Select(arrow => (arrow.Groups[1].Value, arrow.Groups[2].Value))];

    private static Dictionary<string, List<string>> ReachedProjects(List<(string From, string To)> arrows)
    {
        var projectOfBox = BoxOfProject.ToDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal);
        var reached = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        foreach (var (from, to) in arrows)
        {
            if (!projectOfBox.TryGetValue(to, out var target)) continue;
            if (!reached.TryGetValue(from, out var targets)) reached[from] = targets = [];
            if (!targets.Contains(target)) targets.Add(target);
        }
        return reached;
    }
}
