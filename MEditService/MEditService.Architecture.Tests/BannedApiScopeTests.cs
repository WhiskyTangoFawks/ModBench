using System.Collections.Immutable;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace MEditService.Architecture.Tests;

public sealed class BannedApiScopeTests
{
    private const string Rs0030 = "RS0030";

    [Fact]
    public void RS0030_IsAnErrorForEveryHandWrittenFile_AndNoProjectSilencesIt()
    {
        var solution = ServiceProjects.SolutionDirectory();
        var configured = ConfiguredSeverities(solution);
        var files = ServiceProjects.All(solution)
            .SelectMany(project => SourceTree.CSharpFiles(ServiceProjects.Folder(solution, project)))
            .ToList();

        Assert.True(files.Count > 500, $"The severity check read only {files.Count} files.");
        Assert.Empty(files.Where(file => SeverityFor(configured, file) != ReportDiagnostic.Error).Select(file => SourceTree.Relative(solution, file)));
        Assert.Empty(ServiceProjects.All(solution)
            .Select(project => ServiceProjects.Csproj(solution, project))
            .Append(Path.Combine(solution, "Directory.Build.props"))
            .Where(file => XDocument.Load(file).Descendants("NoWarn").Any(noWarn => noWarn.Value.Contains(Rs0030, StringComparison.Ordinal)))
            .Select(file => SourceTree.Relative(solution, file)));
    }

    private static ReportDiagnostic SeverityFor(AnalyzerConfigSet configured, string path) =>
        configured.GetOptionsForSourcePath(path).TreeOptions.TryGetValue(Rs0030, out var severity) ? severity : ReportDiagnostic.Default;

    private static AnalyzerConfigSet ConfiguredSeverities(string solution) =>
        AnalyzerConfigSet.Create(SourceTree.Files(solution, ".editorconfig")
            .Append(Path.Combine(solution, "BannedSymbols.globalconfig"))
            .Select(path => AnalyzerConfig.Parse(File.ReadAllText(path), path))
            .ToImmutableArray());
}
