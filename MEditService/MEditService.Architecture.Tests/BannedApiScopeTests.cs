using System.Collections.Immutable;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using MEditService.TestSupport;
using Microsoft.CodeAnalysis;

namespace MEditService.Architecture.Tests;

public sealed class BannedApiScopeTests
{
    private const string Rs0030 = "RS0030";
    private const string MutagenBan = "BannedSymbols.Mutagen.txt";

    private static readonly string[] HoldersOfLiveMutagenObjects =
    [
        "MEditService.Codec",
        "MEditService.Codec.Fallout4",
        "MEditService.Codec.Fallout4.Proof",
        "MEditService.Codec.Skyrim",
        "MEditService.Codec.Skyrim.Proof",
        "MEditService.Codec.Starfield",
        "MEditService.Codec.Starfield.Proof",
        "MEditService.PluginAdapter",
    ];

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

    [Fact]
    public void EveryProductionProject_ButTheHoldersOfLiveMutagenObjects_CompilesAgainstTheMutagenBan()
    {
        var solution = ServiceProjects.SolutionDirectory();

        Assert.Empty(MutagenBanOffenders(solution, ServiceProjects.Production(solution)));
    }

    [Fact]
    public void TheMutagenBanCheck_NamesAProductionProjectTheBanSkips()
    {
        Assert.Equal(
            ["MEditService.Codec.Planted lacks the Mutagen ban"],
            MutagenBanOffenders(ServiceProjects.SolutionDirectory(), ["MEditService.Codec", "MEditService.Codec.Planted", "MEditService.Commands"]));
    }

    private static List<string> MutagenBanOffenders(string solution, IReadOnlyList<string> production)
    {
        var props = XDocument.Load(Path.Combine(solution, "Directory.Build.props"));
        var banGroups = props.Descendants("AdditionalFiles")
            .Where(item => ((string?)item.Attribute("Include") ?? "").EndsWith(MutagenBan, StringComparison.Ordinal))
            .Select(item => item.Parent.Require())
            .ToList();
        return
        [
            .. production
                .Where(project => banGroups.Any(group => Holds(group, PropertiesOf(props, project))) == HoldersOfLiveMutagenObjects.Contains(project))
                .Select(project => HoldersOfLiveMutagenObjects.Contains(project) ? $"{project} carries the Mutagen ban" : $"{project} lacks the Mutagen ban"),
            .. production
                .Where(project => File.Exists(ServiceProjects.Csproj(solution, project))
                    && File.ReadAllText(ServiceProjects.Csproj(solution, project)) is var csproj
                    && (csproj.Contains("BannedSymbols", StringComparison.Ordinal) || csproj.Contains("BanIncluded", StringComparison.Ordinal)))
                .Select(project => $"{project} sets its own bans"),
        ];
    }

    private static Dictionary<string, string> PropertiesOf(XDocument props, string project)
    {
        var properties = new Dictionary<string, string>(StringComparer.Ordinal) { ["MSBuildProjectName"] = project };
        foreach (var property in props.Root.Require().Elements("PropertyGroup").Where(group => Holds(group, properties)).SelectMany(group => group.Elements()))
        {
            if (Holds(property, properties)) properties[property.Name.LocalName] = property.Value;
        }
        return properties;
    }

    private static readonly Regex Comparison = new(@"^'(?<left>[^']*)'\s*(?<op>==|!=)\s*'(?<right>[^']*)'$", RegexOptions.Compiled);
    private static readonly Regex NameTest = new(@"^(?<not>!)?\$\(MSBuildProjectName\.(?<test>StartsWith|EndsWith)\('(?<arg>[^']*)'\)\)$", RegexOptions.Compiled);
    private static readonly Regex Property = new(@"\$\((?<name>\w+)\)", RegexOptions.Compiled);

    private static bool Holds(XElement element, IReadOnlyDictionary<string, string> properties) =>
        (string?)element.Attribute("Condition") is not { } condition
        || Regex.Split(condition, @"\s+And\s+").All(term => TermHolds(term.Trim(), properties));

    private static bool TermHolds(string term, IReadOnlyDictionary<string, string> properties)
    {
        if (Comparison.Match(term) is { Success: true } comparison)
        {
            var equal = Expand(comparison.Groups["left"].Value, properties) == Expand(comparison.Groups["right"].Value, properties);
            return comparison.Groups["op"].Value == "==" ? equal : !equal;
        }
        if (NameTest.Match(term) is { Success: true } test)
        {
            var name = properties["MSBuildProjectName"];
            var arg = test.Groups["arg"].Value;
            var holds = test.Groups["test"].Value == "StartsWith"
                ? name.StartsWith(arg, StringComparison.Ordinal)
                : name.EndsWith(arg, StringComparison.Ordinal);
            return holds != test.Groups["not"].Success;
        }
        throw new InvalidOperationException($"The ban check reads no condition of the form '{term}'; teach it, or keep the props' conditions to the forms it reads.");
    }

    private static string Expand(string text, IReadOnlyDictionary<string, string> properties) =>
        Property.Replace(text, match => properties.GetValueOrDefault(match.Groups["name"].Value, ""));

    private static ReportDiagnostic SeverityFor(AnalyzerConfigSet configured, string path) =>
        configured.GetOptionsForSourcePath(path).TreeOptions.TryGetValue(Rs0030, out var severity) ? severity : ReportDiagnostic.Default;

    private static AnalyzerConfigSet ConfiguredSeverities(string solution) =>
        AnalyzerConfigSet.Create(SourceTree.Files(solution, ".editorconfig")
            .Concat(SourceTree.Files(solution, "*.globalconfig"))
            .Select(path => AnalyzerConfig.Parse(File.ReadAllText(path), path))
            .ToImmutableArray());
}
