using System.Xml.Linq;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Architecture;

/// <summary>ADR-0032 rule 2 bans the live-object namespaces outside the codec and the Plugin
/// adapter. This pins the transitional folder scope, so shortening the list is an edit here and
/// nothing widens it in passing.</summary>
public sealed class BannedApiScopeTests
{
    private static readonly string[] ExemptSections =
    [
        "MEditService.Core/Commands/**.cs",
        "MEditService.Core/Edits/**.cs",
        "MEditService.Core/Plugins/**.cs",
        "MEditService.Core/Records/**.cs",
        "MEditService.Core/Schema/**.cs",
        "MEditService.Core/Serialization/**.cs",
        "MEditService.Core/Source/**.cs",
        "MEditService.Tests.ProcessEnvironment/**.cs",
        "MEditService.Tests/**.cs",
    ];

    private static readonly string[] BannedNamespaces =
    [
        "N:Mutagen.Bethesda.Plugins.Binary.Parameters",
        "N:Mutagen.Bethesda.Plugins.Cache",
        "N:Mutagen.Bethesda.Plugins.Records",
    ];

    [Fact]
    public void RS0030_IsAnErrorEverywhere_AndOffOnlyInTheFoldersTheTransitionNames()
    {
        var declarations = SeverityDeclarations(
            File.ReadAllLines(Path.Combine(ArchitectureTests.SolutionDirectory(), ".editorconfig")));

        // Later sections win, so the order is the rule: everything after the error section narrows it.
        Assert.Equal(("*.cs", "error"), declarations[0]);
        Assert.All(declarations.Skip(1), d => Assert.Equal("none", d.Severity));
        Assert.Equal(
            ExemptSections,
            declarations.Skip(1).Select(d => d.Section).Order(StringComparer.Ordinal).ToList());
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
    }

    [Fact]
    public void TheSymbolList_BansTheLiveObjectNamespaces_AndLeavesIdentityLegibleEverywhere()
    {
        var lines = SourceTree.ReadAllowlist(
            Path.Combine(ArchitectureTests.SolutionDirectory(), "BannedSymbols.txt"));
        var banned = lines.Select(line => line.Split(';')[0]).Order(StringComparer.Ordinal).ToList();

        Assert.Equal(BannedNamespaces, banned);
        Assert.All(lines, line => Assert.EndsWith(
            "a live Mutagen object reaches nothing but the codec and the Plugin adapter (ADR-0032 rule 2).",
            line, StringComparison.Ordinal));
    }

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
