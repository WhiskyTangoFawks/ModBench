using System.Collections.Immutable;
using System.Xml.Linq;
using MEditService.Tests.TestSupport;
using Microsoft.CodeAnalysis;

namespace MEditService.Tests.Architecture;

/// <summary>ADR-0005 rule 2 bans the live-object namespaces outside the codec and the Plugin
/// adapter. This pins the exemption list, its order, and the severity Roslyn computes from
/// it.</summary>
public sealed class BannedApiScopeTests
{
    // In .editorconfig order, which is the rule: a later section narrows an earlier one.
    private static readonly string[] ExemptSections =
    [
        "MEditService.Codec/Serialization/**.cs",
        "MEditService.Codec/Schema/**.cs",
        "MEditService.PluginAdapter/**.cs",
        "MEditService.Tests/**.cs",
        "MEditService.Tests.ProcessEnvironment/**.cs",
    ];

    private static readonly string[] BannedNamespaces =
    [
        "N:Mutagen.Bethesda.Plugins.Binary.Parameters",
        "N:Mutagen.Bethesda.Plugins.Cache",
        "N:Mutagen.Bethesda.Plugins.Records",
    ];

    private const string Rs0030 = "RS0030";

    [Fact]
    public void RS0030_IsAnErrorEverywhere_AndOffOnlyInTheCodecTheAdapterAndTheTests()
    {
        var declarations = SeverityDeclarations(File.ReadAllLines(EditorConfigPath()));

        Assert.Equal(("*.cs", "error"), declarations[0]);
        Assert.All(declarations.Skip(1), d => Assert.Equal("none", d.Severity));
        Assert.Equal(ExemptSections, declarations.Skip(1).Select(d => d.Section).ToList());
    }

    // A global config outranking .editorconfig would leave every section above advisory and RS0030
    // silent everywhere, so the severity is read back through Roslyn's own config reader.
    [Fact]
    public void TheSeverityRoslynComputes_IsErrorOutsideTheExemptFolders_AndNoneInsideThem()
    {
        var configured = ConfiguredSeverities();

        Assert.Equal(
            ReportDiagnostic.Error,
            configured.For(Path.Combine("MEditService.Core", "Records", "Probe.cs")));
        Assert.Equal(
            ReportDiagnostic.Error,
            configured.For(Path.Combine("MEditService.Core", "Commands", "Probe.cs")));
        Assert.All(
            ExemptSections.Select(section => section.Replace("/**.cs", "", StringComparison.Ordinal)),
            folder => Assert.Equal(
                ReportDiagnostic.Suppress,
                configured.For(Path.Combine(folder.Replace('/', Path.DirectorySeparatorChar), "Probe.cs"))));
    }

    // The one thing the global config is for: no .editorconfig section reaches a source
    // generator's output, and the Mutagen serialization generator emits the codec's serializers.
    [Fact]
    public void TheGlobalConfig_SilencesRS0030_ForTheOutputNoEditorConfigSectionReaches()
    {
        Assert.Equal(ReportDiagnostic.Suppress, ConfiguredSeverities().Global);
    }

    [Fact]
    public void TheAnalyzerAndItsSymbolList_AreWiredOnce_ForEveryProject()
    {
        var props = XDocument.Load(
            Path.Combine(ArchitectureTests.SolutionDirectory(), "Directory.Build.props"));

        Assert.Contains(
            props.Descendants("PackageReference"),
            e => (string?)e.Attribute("Include") == "Microsoft.CodeAnalysis.BannedApiAnalyzers");
        Assert.Contains(
            props.Descendants("AdditionalFiles"),
            e => ((string?)e.Attribute("Include"))?.EndsWith("BannedSymbols.txt", StringComparison.Ordinal) == true);
        Assert.Contains(
            props.Descendants("EditorConfigFiles"),
            e => ((string?)e.Attribute("Include"))?.EndsWith("BannedSymbols.globalconfig", StringComparison.Ordinal) == true);
    }

    [Fact]
    public void TheSymbolList_BansTheLiveObjectNamespaces_AndLeavesIdentityLegibleEverywhere()
    {
        var lines = SourceTree.ReadAllowlist(
            Path.Combine(ArchitectureTests.SolutionDirectory(), "BannedSymbols.txt"));
        var banned = lines.Select(line => line.Split(';')[0]).Order(StringComparer.Ordinal).ToList();

        Assert.Equal(BannedNamespaces, banned);
        Assert.All(lines, line => Assert.EndsWith(
            "a live Mutagen object reaches nothing but the codec and the Plugin adapter (ADR-0005 rule 2).",
            line, StringComparison.Ordinal));
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
