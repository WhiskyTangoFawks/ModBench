using System.Collections.Immutable;
using System.Xml.Linq;
using MEditService.Tests.TestSupport;
using Microsoft.CodeAnalysis;

namespace MEditService.Tests.Architecture;

/// <summary>RS0030 is error everywhere. Two banned lists split the reason: BannedSymbols.txt (time,
/// blocking waits) binds unconditionally; BannedSymbols.Mutagen.txt (ADR-0005 rule 2) excludes by
/// name the six boxes a live Mutagen object reaches.</summary>
public sealed class BannedApiScopeTests
{
    // Directory.Build.props sets MutagenBanExempt for exactly these six projects.
    private static readonly string[] MutagenBanExemptProjects =
    [
        "MEditService.Codec",
        "MEditService.Codec.Tests",
        "MEditService.CrossBox.Tests",
        "MEditService.PluginAdapter",
        "MEditService.PluginAdapter.Tests",
        "MEditService.TestSupport",
    ];

    private static readonly string[] BannedNamespaces =
    [
        "N:Mutagen.Bethesda.Plugins.Binary.Parameters",
        "N:Mutagen.Bethesda.Plugins.Cache",
        "N:Mutagen.Bethesda.Plugins.Records",
    ];

    private static readonly string[] BannedTimeAndBlockingWaitSymbols =
    [
        "P:System.DateTime.Now",
        "P:System.DateTime.UtcNow",
        "P:System.DateTimeOffset.Now",
        "P:System.DateTimeOffset.UtcNow",
        "P:System.Threading.Tasks.Task`1.Result",
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
                "MEditService.TestSupport", "MEditService.CrossBox.Tests" },
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
    public void TheMutagenBanFile_ExcludesExactlyTheSixNamedProjects()
    {
        var props = LoadBuildProps();

        var exemptProperties = props.Descendants("MutagenBanExempt").ToList();
        Assert.All(exemptProperties, e => Assert.Equal("true", e.Value));
        var namedProjects = exemptProperties
            .Select(e => ProjectNamedBy((string?)e.Attribute("Condition") ?? ""))
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.Equal(MutagenBanExemptProjects, namedProjects);

        var mutagenFile = Assert.Single(
            props.Descendants("AdditionalFiles"),
            e => ((string?)e.Attribute("Include"))?.EndsWith("BannedSymbols.Mutagen.txt", StringComparison.Ordinal) == true);
        Assert.Equal("'$(MutagenBanExempt)' != 'true'", (string?)mutagenFile.Parent?.Attribute("Condition"));
    }

    // 'MSBuildProjectName' == 'MEditService.Codec' split on the quotes it is built from.
    private static string ProjectNamedBy(string condition)
    {
        var parts = condition.Split('\'');
        Assert.True(parts.Length >= 4, $"Expected a quoted MSBuildProjectName equality condition, got '{condition}'.");
        return parts[3];
    }

    [Fact]
    public void TheMutagenSymbolList_BansTheLiveObjectNamespaces_AndLeavesIdentityLegibleEverywhere()
    {
        var lines = MutagenSymbolLines();
        var banned = lines.Select(line => line.Split(';')[0]).Order(StringComparer.Ordinal).ToList();

        Assert.Equal(BannedNamespaces, banned);
        Assert.All(lines, line => Assert.EndsWith(
            "a live Mutagen object reaches nothing but the codec and the Plugin adapter (ADR-0005 rule 2).",
            line, StringComparison.Ordinal));
    }

    [Fact]
    public void TheTimeSymbolList_BansTheCurrentTimeAndBlockingResult_NamingTheReplacement()
    {
        var lines = TimeSymbolLines();
        var banned = lines.Select(line => line.Split(';')[0]).Order(StringComparer.Ordinal).ToList();

        Assert.Equal(BannedTimeAndBlockingWaitSymbols.Order(StringComparer.Ordinal), banned);
        Assert.All(lines, line => Assert.Contains(';', line));
        Assert.Contains(lines, line => line.Contains("TimeProvider", StringComparison.Ordinal));
        Assert.Contains(lines, line => line.Contains("Await the task", StringComparison.Ordinal));
    }

    private static IReadOnlyList<string> TimeSymbolLines() =>
        SourceTree.ReadAllowlist(Path.Combine(ArchitectureTests.SolutionDirectory(), "BannedSymbols.txt"));

    private static IReadOnlyList<string> MutagenSymbolLines() =>
        SourceTree.ReadAllowlist(Path.Combine(ArchitectureTests.SolutionDirectory(), "BannedSymbols.Mutagen.txt"));

    // Read off disk rather than listed: a box added tomorrow is banned the moment its project file
    // exists. Keyed on the project file, so a leftover obj folder is not a box.
    private static IReadOnlyList<string> ProductionProjects() =>
        [.. Directory.EnumerateFiles(
                ArchitectureTests.SolutionDirectory(), "MEditService.*.csproj", SearchOption.AllDirectories)
            .Select(project => Path.GetFileNameWithoutExtension(project))
            .Where(name => !IsATestProject(name))
            .Order(StringComparer.Ordinal)];

    // Every box's own test project (MEditService.<Box>.Tests), the process-isolated suite, and the
    // shared fixture library — none of them a box the target architecture draws.
    private static bool IsATestProject(string name) =>
        name.StartsWith("MEditService.Tests", StringComparison.Ordinal)
        || name.EndsWith(".Tests", StringComparison.Ordinal)
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

    // ADR-0005 rule 2 across the split: naming an IMod needs a game assembly, so only these two
    // boxes call the codec's whole-mod doors — both must be in the exempt six, or RS0030 bans
    // them.
    [Fact]
    public void TheGameAssemblies_AreTheCodecsAndTheAdapters_AndBothAreMutagenBanExempt()
    {
        var projects = ProductionProjects();

        // Zero projects and a correct answer read the same; this tells them apart.
        Assert.True(projects.Count > 5, $"The project scan found only {projects.Count} production projects.");

        var holders = projects.Where(HoldsAGameAssembly).ToList();

        Assert.Equal(["MEditService.Codec", "MEditService.PluginAdapter"], holders);
        Assert.All(holders, project => Assert.Contains(project, MutagenBanExemptProjects));
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
