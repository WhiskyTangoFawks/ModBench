using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

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

    [Fact]
    public void EveryTraceSuffixedClass_NamesATraceFile()
    {
        var solution = ArchitectureTests.SolutionDirectory();
        var traceStems = TraceFileStems(solution);
        var orphans = TraceSuffixedClasses(solution)
            .Where(name => !traceStems.Contains(TraceStemFor(name)))
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(
            orphans.Count == 0,
            $"{orphans.Count} class(es) end in TraceTests but name no file under docs/architecture/traces/. "
            + "Rename the class to the trace it now covers, or drop the suffix (to *ApiTests) once its flow "
            + "is folded into a trace another class already covers:\n"
            + string.Join("\n", orphans));
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

    private static HashSet<string> TraceFileStems(string solution) =>
        [.. Directory
            .EnumerateFiles(Path.Combine(ServiceProjects.DocsArchitecture(solution), "traces"), "*.d2")
            .Select(trace => Path.GetFileNameWithoutExtension(trace))];

    private static List<string> TraceSuffixedClasses(string solution) =>
        [.. SourceTree.CSharpFiles(ServiceProjects.Folder(solution, Endpoints))
            .SelectMany(file => Regex.Matches(File.ReadAllText(file), @"\bclass\s+(\w+TraceTests)\b"))
            .Select(match => match.Groups[1].Value)];

    // The inverse of ClassNameFor: each capital starts a new word, lowercased and hyphen-joined.
    private static string TraceStemFor(string traceSuffixedClass)
    {
        var stem = traceSuffixedClass[..^"TraceTests".Length];
        return string.Join('-', Regex.Matches(stem, "[A-Z][a-z0-9]*").Select(m => m.Value.ToLowerInvariant()));
    }
}
