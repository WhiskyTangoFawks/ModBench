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
        var severities = SeverityBySection(
            File.ReadAllLines(Path.Combine(ArchitectureTests.SolutionDirectory(), ".editorconfig")));

        Assert.Equal("error", severities.GetValueOrDefault("*.cs"));
        Assert.Equal(
            ExemptSections,
            severities.Where(s => s.Value == "none").Select(s => s.Key).Order(StringComparer.Ordinal).ToList());
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

    private static Dictionary<string, string> SeverityBySection(IEnumerable<string> lines)
    {
        var severities = new Dictionary<string, string>(StringComparer.Ordinal);
        var section = "";
        foreach (var line in lines.Select(l => l.Trim()))
        {
            if (line.StartsWith('[') && line.EndsWith(']')) section = line[1..^1];
            else if (line.StartsWith("dotnet_diagnostic.RS0030.severity", StringComparison.Ordinal))
                severities[section] = line.Split('=')[1].Trim();
        }
        return severities;
    }
}
