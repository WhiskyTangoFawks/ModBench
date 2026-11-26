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
        Assert.Empty(files.Where(file => InSourceSuppression.IsMatch(File.ReadAllText(file))).Select(file => SourceTree.Relative(solution, file)));
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
    public void TheSuppressionScan_NamesAPragmaAndAnAttributeSilencingRS0030()
    {
        Assert.Matches(InSourceSuppression, $"#pragma warning disable {Rs0030} // a banned call");
        Assert.Matches(InSourceSuppression, $"[SuppressMessage(\"ApiDesign\", \"{Rs0030}:Do not use banned APIs\")]");
    }

    [Fact]
    public void TheMutagenBanCheck_NamesAProjectTheBanSkips_OneThatSetsItsOwnBans_AndANestedBuildFile()
    {
        using var solution = new ScratchDirectory("medit-mutagen-ban-");
        File.Copy(Path.Combine(ServiceProjects.SolutionDirectory(), "Directory.Build.props"), Path.Combine(solution, "Directory.Build.props"));
        ScratchFiles.Plant(solution, "MEditService.Box/MEditService.Box.csproj",
            "<Project><ItemGroup><AdditionalFiles Remove=\"@(AdditionalFiles)\" /></ItemGroup></Project>");
        ScratchFiles.Plant(solution, "MEditService.Box/Directory.Build.props", "<Project />");

        Assert.Equal(
            [
                "MEditService.Box sets its own bans",
                "MEditService.Box/Directory.Build.props stands between a box and the root props",
                "MEditService.Codec.Planted lacks the Mutagen ban",
            ],
            MutagenBanOffenders(solution, ["MEditService.Box", "MEditService.Codec", "MEditService.Codec.Planted"]).Order(StringComparer.Ordinal));
    }

    private static readonly Regex InSourceSuppression = new(
        @"#pragma\s+warning\s+disable\b[^\n]*\bRS0030\b|SuppressMessage\([^)]*\bRS0030\b", RegexOptions.Compiled);

    private static List<string> MutagenBanOffenders(string solution, IReadOnlyList<string> production)
    {
        var props = XDocument.Load(Path.Combine(solution, "Directory.Build.props"));
        var bans = props.Descendants("AdditionalFiles")
            .Where(item => item.Attributes().Any(attribute => attribute.Value.EndsWith(MutagenBan, StringComparison.Ordinal)))
            .ToList();
        if (bans.Any(item => item.Attribute("Include") is null))
            throw new InvalidOperationException($"Directory.Build.props removes or updates {MutagenBan}; the ban check reads only an Include.");
        return
        [
            .. production
                .Where(project => HoldersOfLiveMutagenObjects.Contains(project)
                    == bans.Any(item => PropertiesOf(props, project) is var properties && Holds(item, properties) && Holds(item.Parent.Require(), properties)))
                .Select(project => HoldersOfLiveMutagenObjects.Contains(project) ? $"{project} carries the Mutagen ban" : $"{project} lacks the Mutagen ban"),
            .. production
                .Where(project => File.Exists(ServiceProjects.Csproj(solution, project))
                    && File.ReadAllText(ServiceProjects.Csproj(solution, project)) is var csproj
                    && ProjectBanNeedles.Any(needle => csproj.Contains(needle, StringComparison.Ordinal)))
                .Select(project => $"{project} sets its own bans"),
            .. SourceTree.Files(solution, "Directory.Build.*")
                .Select(file => SourceTree.Relative(solution, file))
                .Where(file => file.Contains('/', StringComparison.Ordinal) && !file.StartsWith("vendor/", StringComparison.Ordinal))
                .Select(file => $"{file} stands between a box and the root props"),
        ];
    }

    private static readonly string[] ProjectBanNeedles = ["BannedSymbols", "BanIncluded", "AdditionalFiles", "<Import"];

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
            var equal = string.Equals(
                Expand(comparison.Groups["left"].Value, properties), Expand(comparison.Groups["right"].Value, properties), StringComparison.OrdinalIgnoreCase);
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
            .Append(Path.Combine(solution, "BannedSymbols.globalconfig"))
            .Select(path => AnalyzerConfig.Parse(File.ReadAllText(path), path))
            .ToImmutableArray());
}
