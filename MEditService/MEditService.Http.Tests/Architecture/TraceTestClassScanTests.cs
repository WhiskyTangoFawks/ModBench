using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>The traces are the integration suite: a trace that draws an mEdit box as an actor is a
/// flow the endpoints compose, so it has one test class here, named for the trace file.</summary>
public sealed class TraceTestClassScanTests
{
    private const string Endpoints = "MEditService.Http.Tests";

    [Fact]
    public void EveryTraceThatDrawsAnMEditActor_HasATestClassNamedForIt()
    {
        var solution = ArchitectureTests.SolutionDirectory();
        var traces = TracesWithAnMEditActor(solution);
        var classes = DeclaredClasses(solution);
        var missing = traces
            .Where(trace => !classes.Contains(ClassNameFor(trace)))
            .Select(trace => $"traces/{Path.GetFileName(trace)}: no class {ClassNameFor(trace)} in {Endpoints}")
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(
            traces.Count > 5,
            $"The trace scan found {traces.Count} trace(s) drawing an mEdit actor — it is reading the "
            + "wrong tree, so it would pass by finding nothing.");
        Assert.True(
            missing.Count == 0,
            $"{missing.Count} trace(s) have no test class. Add the class to {Endpoints}, one round trip "
            + "through the real host asserting what a client sees — the reply, the notification "
            + "stream, a following query — with disk as setup and the other tool's hand, never as an "
            + "assertion:\n"
            + string.Join("\n", missing));
    }

    private static List<string> TracesWithAnMEditActor(string solution) =>
        [.. Directory
            .EnumerateFiles(Path.Combine(ServiceProjects.DocsArchitecture(solution), "traces"), "*.d2")
            .Where(trace => Regex.IsMatch(
                File.ReadAllText(trace), @"@[\w./]*target-architecture\.medit_(?!data\.)"))
            .Order(StringComparer.Ordinal)];

    private static HashSet<string> DeclaredClasses(string solution) =>
        [.. SourceTree.CSharpFiles(ServiceProjects.Folder(solution, Endpoints))
            .SelectMany(file => Regex.Matches(File.ReadAllText(file), @"\bclass\s+(\w+)"))
            .Select(match => match.Groups[1].Value)];

    private static string ClassNameFor(string trace) =>
        string.Concat(Path.GetFileNameWithoutExtension(trace)
            .Split('-')
            .Select(word => char.ToUpperInvariant(word[0]) + word[1..])) + "TraceTests";
}
