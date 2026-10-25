using System.Collections.Immutable;
using System.Diagnostics;
using System.Text.Json;
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
        var configured = ConfiguredSeverities();
        var files = ServiceProjects.All(solution)
            .SelectMany(project => SourceTree.CSharpFiles(ServiceProjects.Folder(solution, project)))
            .ToList();

        Assert.True(files.Count > 500, $"The severity check read only {files.Count} files.");
        Assert.Empty(files.Where(file => configured.For(file) != ReportDiagnostic.Error).Select(file => SourceTree.Relative(solution, file)));
        Assert.Empty(ServiceProjects.All(solution)
            .Select(project => ServiceProjects.Csproj(solution, project))
            .Append(Path.Combine(solution, "Directory.Build.props"))
            .Where(file => XDocument.Load(file).Descendants("NoWarn").Any(noWarn => noWarn.Value.Contains(Rs0030, StringComparison.Ordinal)))
            .Select(file => SourceTree.Relative(solution, file)));
    }

    [Fact]
    public void TheGlobalConfig_SilencesRS0030_ForTheOutputNoEditorConfigSectionReaches()
    {
        Assert.Equal(ReportDiagnostic.Suppress, ConfiguredSeverities().Global);
    }

    private const string MutagenBan = "BannedSymbols.Mutagen.txt";
    private const string SyncOverAsyncBan = "BannedSymbols.SyncOverAsync.txt";
    private const string TimeAndBlockingBan = "BannedSymbols.txt";

    public static IEnumerable<object[]> EveryProjectAndTheBanFilesItCompilesAgainst =>
        ServiceProjects.All(ServiceProjects.SolutionDirectory()).Select(project => new object[] { project, BanFilesFor(project) });

    private static string[] BanFilesFor(string project) =>
        ServiceProjects.IsTestSide(project) ? [TimeAndBlockingBan]
        : HoldersOfLiveMutagenObjects.Contains(project) ? [SyncOverAsyncBan, TimeAndBlockingBan]
        : [MutagenBan, SyncOverAsyncBan, TimeAndBlockingBan];

    private static readonly string[] HoldersOfLiveMutagenObjects =
    [
        "MEditService.Codec",
        "MEditService.Codec.Fallout4",
        "MEditService.Codec.Skyrim",
        "MEditService.Codec.Starfield",
        "MEditService.PluginAdapter",
    ];

    private static readonly TimeSpan EvaluationTimeout = TimeSpan.FromSeconds(15);

    [Theory]
    [MemberData(nameof(EveryProjectAndTheBanFilesItCompilesAgainst))]
    public async Task AProject_CompilesAgainstTheBanFilesOfItsSide_WithTheAnalyzerAndTheGlobalConfig(string project, string[] banFiles)
    {
        var items = await EvaluatedItems(project, "AdditionalFiles", "PackageReference", "EditorConfigFiles");

        Assert.Equal(banFiles, items["AdditionalFiles"].Where(file => file.StartsWith("BannedSymbols", StringComparison.Ordinal)).Order(StringComparer.Ordinal));
        Assert.Contains("Microsoft.CodeAnalysis.BannedApiAnalyzers", items["PackageReference"]);
        Assert.Contains("BannedSymbols.globalconfig", items["EditorConfigFiles"]);
    }

    private static async Task<Dictionary<string, List<string>>> EvaluatedItems(string project, params string[] itemTypes)
    {
        var solution = ServiceProjects.SolutionDirectory();
        var evaluation = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        evaluation.ArgumentList.Add("msbuild");
        evaluation.ArgumentList.Add(ServiceProjects.Csproj(solution, project));
        evaluation.ArgumentList.Add("-nodeReuse:false");
        foreach (var itemType in itemTypes) evaluation.ArgumentList.Add($"-getItem:{itemType}");
        using var process = Process.Start(evaluation) ?? throw new InvalidOperationException("dotnet did not start.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(EvaluationTimeout);
        try
        {
            await process.WaitForExitAsync(deadline.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail($"dotnet msbuild did not evaluate {project} within {EvaluationTimeout.TotalSeconds} s.");
        }
        Assert.True(process.ExitCode == 0, $"dotnet msbuild could not evaluate {project}:\n{await output}\n{await error}");

        using var json = JsonDocument.Parse(await output);
        return itemTypes.ToDictionary(
            itemType => itemType,
            itemType => json.RootElement.GetProperty("Items").GetProperty(itemType).EnumerateArray()
                .Select(item => Path.GetFileName(item.GetProperty("Identity").GetString() ?? string.Empty))
                .ToList());
    }

    private static bool HoldsAGameAssembly(string project) =>
        XDocument.Load(ServiceProjects.Csproj(ServiceProjects.SolutionDirectory(), project))
            .Descendants("PackageReference")
            .Select(e => (string?)e.Attribute("Include") ?? "")
            .Any(IsAPerGameMutagenPackage);

    private static bool IsAPerGameMutagenPackage(string id) =>
        id.StartsWith("Mutagen.Bethesda.", StringComparison.Ordinal)
        && !string.Equals(id, "Mutagen.Bethesda.Core", StringComparison.Ordinal)
        && !id.StartsWith("Mutagen.Bethesda.Serialization", StringComparison.Ordinal);

    [Fact]
    public void TheGameAssemblies_AreTheCodecsGameProjectsOnly()
    {
        var projects = ServiceProjects.Production(ServiceProjects.SolutionDirectory());

        var holders = projects.Where(HoldsAGameAssembly).ToList();

        Assert.Equal(["MEditService.Codec.Fallout4", "MEditService.Codec.Skyrim", "MEditService.Codec.Starfield"], holders);
    }

    private sealed record ConfiguredSeverity(AnalyzerConfigSet Set)
    {
        internal ReportDiagnostic Global =>
            Set.GlobalConfigOptions.TreeOptions.TryGetValue(Rs0030, out var severity)
                ? severity
                : ReportDiagnostic.Default;

        public ReportDiagnostic For(string path) =>
            Set.GetOptionsForSourcePath(path).TreeOptions
                .TryGetValue(Rs0030, out var severity)
                ? severity
                : ReportDiagnostic.Default;
    }

    private static ConfiguredSeverity ConfiguredSeverities()
    {
        var solutionDirectory = ServiceProjects.SolutionDirectory();
        var globalConfigPath = Path.Combine(solutionDirectory, "BannedSymbols.globalconfig");

        return new ConfiguredSeverity(
            AnalyzerConfigSet.Create(EditorConfigs(solutionDirectory)
                .Append(globalConfigPath)
                .Select(path => AnalyzerConfig.Parse(File.ReadAllText(path), path))
                .ToImmutableArray()));
    }

    private static IEnumerable<string> EditorConfigs(string solutionDirectory) =>
        SourceTree.Files(solutionDirectory, ".editorconfig");
}
