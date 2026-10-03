using System.Collections.Immutable;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace MEditService.Http.Tests.Architecture;

public sealed class BannedApiScopeTests
{
    private static readonly string[] MutagenBanProductionProjects =
    [
        "MEditService.Commands",
        "MEditService.Http",
        "MEditService.Index",
        "MEditService.LoadOrder",
        "MEditService.Ports",
        "MEditService.Queries",
        "MEditService.SourceAdapter",
    ];

    private const string Rs0030 = "RS0030";

    [Fact]
    public void RS0030_IsAnErrorEverywhere_WithNoPerFolderOrPerProjectSeverity()
    {
        var declaration = Assert.Single(SeverityDeclarations(File.ReadAllLines(EditorConfigPath())));
        Assert.Equal(("*.cs", "error"), declaration);
    }

    // A global config outranking .editorconfig would leave RS0030 advisory everywhere, so the
    // severity is read back through Roslyn's own config reader, not just grepped.
    [Fact]
    public void TheSeverityRoslynComputes_IsErrorForEveryProject()
    {
        var configured = ConfiguredSeverities();

        Assert.All(
            new[] { "MEditService.Index", "MEditService.Commands", "MEditService.Codec", "MEditService.PluginAdapter",
                "MEditService.TestSupport" },
            project => Assert.Equal(ReportDiagnostic.Error, configured.For(Path.Combine(project, "Probe.cs"))));
    }

    // The one thing the global config is for: no .editorconfig section reaches a source
    // generator's output, and the Mutagen serialization generator emits the codec's serializers.
    [Fact]
    public void TheGlobalConfig_SilencesRS0030_ForTheOutputNoEditorConfigSectionReaches()
    {
        Assert.Equal(ReportDiagnostic.Suppress, ConfiguredSeverities().Global);
    }

    [Fact]
    public void TheAnalyzerAndTheTimeFile_AreWiredUnconditionally_ForEveryProject()
    {
        var props = LoadBuildProps();

        Assert.Contains(
            props.Descendants("PackageReference"),
            e => (string?)e.Attribute("Include") == "Microsoft.CodeAnalysis.BannedApiAnalyzers");
        Assert.Contains(
            props.Descendants("EditorConfigFiles"),
            e => ((string?)e.Attribute("Include"))?.EndsWith("BannedSymbols.globalconfig", StringComparison.Ordinal) == true);

        var timeFile = Assert.Single(
            props.Descendants("AdditionalFiles"),
            e => ((string?)e.Attribute("Include"))?.EndsWith("BannedSymbols.txt", StringComparison.Ordinal) == true);
        Assert.Null(timeFile.Parent?.Attribute("Condition"));
    }

    [Fact]
    public void TheMutagenBanFile_IncludesExactlyTheSevenNamedProductionProjects()
    {
        var props = LoadBuildProps();

        var includedProperties = props.Descendants("MutagenBanIncluded").ToList();
        Assert.All(includedProperties, e => Assert.Equal("true", e.Value));
        var namedProjects = includedProperties
            .Select(e => ProjectNamedBy((string?)e.Attribute("Condition") ?? ""))
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.Equal(MutagenBanProductionProjects, namedProjects);

        var mutagenFile = Assert.Single(
            props.Descendants("AdditionalFiles"),
            e => ((string?)e.Attribute("Include"))?.EndsWith("BannedSymbols.Mutagen.txt", StringComparison.Ordinal) == true);
        Assert.Equal("'$(MutagenBanIncluded)' == 'true'", (string?)mutagenFile.Parent?.Attribute("Condition"));
    }

    // 'MSBuildProjectName' == 'MEditService.Codec' split on the quotes it is built from.
    private static string ProjectNamedBy(string condition)
    {
        var parts = condition.Split('\'');
        Assert.True(parts.Length >= 4, $"Expected a quoted MSBuildProjectName equality condition, got '{condition}'.");
        return parts[3];
    }

    // A test fixture may block on the tree it builds, so the file binds by the same naming rule the
    // gates read the solution with: every box, no .Tests project, not the fixture library.
    [Fact]
    public void TheSyncOverAsyncFile_BindsEveryProductionBox_AndNoTestProject()
    {
        var props = LoadBuildProps();

        var file = Assert.Single(
            props.Descendants("AdditionalFiles"),
            e => ((string?)e.Attribute("Include"))?.EndsWith("BannedSymbols.SyncOverAsync.txt", StringComparison.Ordinal) == true);
        Assert.Equal("'$(SyncOverAsyncBanIncluded)' == 'true'", (string?)file.Parent?.Attribute("Condition"));

        var included = Assert.Single(props.Descendants("SyncOverAsyncBanIncluded"));
        Assert.Equal("true", included.Value);
        var condition = (string?)included.Attribute("Condition") ?? "";
        Assert.Contains("!$(MSBuildProjectName.EndsWith('.Tests'))", condition, StringComparison.Ordinal);
        Assert.Contains("'$(MSBuildProjectName)' != 'MEditService.TestSupport'", condition, StringComparison.Ordinal);
    }

    // Read off disk rather than listed: a box added tomorrow is banned the moment its project file
    // exists. Keyed on the project file, so a leftover obj folder is not a box.
    private static IReadOnlyList<string> ProductionProjects() =>
        [.. Directory.EnumerateFiles(
                ArchitectureTests.SolutionDirectory(), "MEditService.*.csproj", SearchOption.AllDirectories)
            .Select(project => Path.GetFileNameWithoutExtension(project))
            .Where(name => !IsATestProject(name))
            .Order(StringComparer.Ordinal)];

    // Every box's own test project (MEditService.<Box>.Tests) and the shared fixture library —
    // neither a box the target architecture draws.
    private static bool IsATestProject(string name) =>
        name.EndsWith(".Tests", StringComparison.Ordinal)
        || string.Equals(name, "MEditService.TestSupport", StringComparison.Ordinal);

    // A game assembly is Mutagen's per-release package. Core carries identity alone and is ambient
    // in Directory.Build.props; the serialization packages are the codec's JSON kernel (ADR-0007),
    // not a game.
    private static bool HoldsAGameAssembly(string project) =>
        XDocument.Load(Path.Combine(ArchitectureTests.SolutionDirectory(), project, project + ".csproj"))
            .Descendants("PackageReference")
            .Select(e => (string?)e.Attribute("Include") ?? "")
            .Any(id => id.StartsWith("Mutagen.Bethesda.", StringComparison.Ordinal)
                && !string.Equals(id, "Mutagen.Bethesda.Core", StringComparison.Ordinal)
                && !id.StartsWith("Mutagen.Bethesda.Serialization", StringComparison.Ordinal));

    [Fact]
    public void TheGameAssemblies_AreTheCodecsAndTheAdapters_AndNeitherCarriesTheMutagenBanFile()
    {
        var projects = ProductionProjects();

        // Zero projects and a correct answer read the same; this tells them apart.
        Assert.True(projects.Count > 5, $"The project scan found only {projects.Count} production projects.");

        var holders = projects.Where(HoldsAGameAssembly).ToList();

        Assert.Equal(["MEditService.Codec", "MEditService.PluginAdapter"], holders);
        Assert.All(holders, project => Assert.DoesNotContain(project, MutagenBanProductionProjects));
    }

    private sealed record ConfiguredSeverity(AnalyzerConfigSet Set, string SolutionDirectory)
    {
        internal ReportDiagnostic Global =>
            Set.GlobalConfigOptions.TreeOptions.TryGetValue(Rs0030, out var severity)
                ? severity
                : ReportDiagnostic.Default;

        public ReportDiagnostic For(string relativePath) =>
            Set.GetOptionsForSourcePath(Path.Combine(SolutionDirectory, relativePath)).TreeOptions
                .TryGetValue(Rs0030, out var severity)
                ? severity
                : ReportDiagnostic.Default;
    }

    private static ConfiguredSeverity ConfiguredSeverities()
    {
        var solutionDirectory = ArchitectureTests.SolutionDirectory();
        var globalConfigPath = Path.Combine(solutionDirectory, "BannedSymbols.globalconfig");

        return new ConfiguredSeverity(
            AnalyzerConfigSet.Create(ImmutableArray.Create(
                AnalyzerConfig.Parse(File.ReadAllText(EditorConfigPath()), EditorConfigPath()),
                AnalyzerConfig.Parse(File.ReadAllText(globalConfigPath), globalConfigPath))),
            solutionDirectory);
    }

    private static string EditorConfigPath() =>
        Path.Combine(ArchitectureTests.SolutionDirectory(), ".editorconfig");

    private static XDocument LoadBuildProps() =>
        XDocument.Load(Path.Combine(ArchitectureTests.SolutionDirectory(), "Directory.Build.props"));

    private static List<(string Section, string Severity)> SeverityDeclarations(IEnumerable<string> lines)
    {
        var declarations = new List<(string, string)>();
        var section = "";
        foreach (var line in lines.Select(l => l.Trim()))
        {
            if (line.StartsWith('[') && line.EndsWith(']')) section = line[1..^1];
            else if (line.StartsWith("dotnet_diagnostic.RS0030.severity", StringComparison.Ordinal))
                declarations.Add((section, line.Split('=')[1].Trim()));
        }
        return declarations;
    }
}
