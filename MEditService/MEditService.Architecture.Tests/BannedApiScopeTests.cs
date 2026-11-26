using System.Collections.Immutable;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using MEditService.TestSupport;
using Microsoft.CodeAnalysis;

namespace MEditService.Architecture.Tests;

public sealed class BannedApiScopeTests
{
    private const string Rs0030 = "RS0030";
    private const string Analyzer = "Microsoft.CodeAnalysis.BannedApiAnalyzers";
    private const string MutagenBan = "BannedSymbols.Mutagen.txt";
    private const string SyncOverAsyncBan = "BannedSymbols.SyncOverAsync.txt";
    private const string TimeAndBlockingBan = "BannedSymbols.txt";

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

    private static readonly string[] ProjectBanNeedles = ["BannedSymbols", "BanIncluded", "BannedApiAnalyzers", "AdditionalFiles", "<Import", "Remove=\"@("];

    private static readonly Regex InSourceSuppression = new(
        @"#pragma\s+warning\s+disable(?:[ \t]*(?://[^\r\n]*)?\r?$|\b[^\n]*\bRS0030\b)|SuppressMessage\([^)]*\bRS0030\b",
        RegexOptions.Compiled | RegexOptions.Multiline);

    [Fact]
    public void RS0030_IsAnErrorForEveryHandWrittenFile_AndNoProjectSilencesIt()
    {
        var solution = ServiceProjects.SolutionDirectory();
        var configured = AnalyzerConfigSet.Create(SourceTree.Files(solution, ".editorconfig")
            .Select(path => AnalyzerConfig.Parse(File.ReadAllText(path), path))
            .ToImmutableArray());
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

    [Theory]
    [InlineData("#pragma warning disable RS" + "0030 // a banned call")]
    [InlineData("#pragma warning disable\nvar now = DateTime.Now;")]
    [InlineData("[SuppressMessage(\"ApiDesign\", \"RS" + "0030:Do not use banned APIs\")]")]
    public void TheSuppressionScan_NamesEachWayASourceFileSilencesRS0030(string source)
    {
        Assert.Matches(InSourceSuppression, source);
    }

    [Fact]
    public void EveryProject_CompilesAgainstTheAnalyzerAndTheBanFilesOfItsSide()
    {
        var solution = ServiceProjects.SolutionDirectory();

        Assert.Empty(BanOffenders(solution, ServiceProjects.All(solution)));
    }

    private const string AllBound = $"{Analyzer}, BannedSymbols.Mutagen.txt, BannedSymbols.SyncOverAsync.txt, BannedSymbols.txt";
    private const string PlantedSkipped = $"MEditService.Codec.Planted compiles against {Analyzer}, BannedSymbols.SyncOverAsync.txt, BannedSymbols.txt, not {AllBound}";

    public static TheoryData<string, string, string[]> PlantedBanEscapes => new()
    {
        {
            "<AdditionalFiles Include=\"$(MSBuildThisFileDirectory)BannedSymbols.Mutagen.txt\" />",
            "<AdditionalFiles Include=\"$(MSBuildThisFileDirectory)BannedSymbols.Mutagen.txt\" Condition=\"'$(MSBuildProjectName)' != 'meditservice.commands'\" />",
            [PlantedSkipped, $"MEditService.Commands compiles against {Analyzer}, BannedSymbols.SyncOverAsync.txt, BannedSymbols.txt, not {AllBound}"]
        },
        {
            $"<PackageReference Include=\"{Analyzer}\" Version=",
            $"<PackageReference Include=\"{Analyzer}\" Condition=\"'$(MSBuildProjectName)' != 'MEditService.Commands'\" Version=",
            [PlantedSkipped, $"MEditService.Commands compiles against BannedSymbols.Mutagen.txt, BannedSymbols.SyncOverAsync.txt, BannedSymbols.txt, not {AllBound}"]
        },
    };

    [Theory]
    [MemberData(nameof(PlantedBanEscapes))]
    public void TheBanCheck_NamesAProjectTheBansSkip_ByThePropsPrefixOrByAConditionOnABanItem(string inProps, string replacedBy, string[] offences)
    {
        using var solution = new ScratchDirectory("medit-ban-check-");
        var props = File.ReadAllText(Path.Combine(ServiceProjects.SolutionDirectory(), "Directory.Build.props"));
        File.WriteAllText(Path.Combine(solution, "Directory.Build.props"), props.Replace(inProps, replacedBy, StringComparison.Ordinal));

        Assert.Equal(offences, BanOffenders(solution, ["MEditService.Codec", "MEditService.Codec.Planted", "MEditService.Commands"]));
    }

    [Fact]
    public void TheBanCheck_NamesAProjectThatSetsItsOwnBans_AndABuildFileBesideTheRootProps()
    {
        using var solution = new ScratchDirectory("medit-ban-check-");
        File.Copy(Path.Combine(ServiceProjects.SolutionDirectory(), "Directory.Build.props"), Path.Combine(solution, "Directory.Build.props"));
        ScratchFiles.Plant(solution, "MEditService.Box.Tests/MEditService.Box.Tests.csproj",
            $"<Project><ItemGroup><PackageReference Remove=\"{Analyzer}\" /></ItemGroup></Project>");
        ScratchFiles.Plant(solution, "Directory.Build.targets", "<Project />");

        Assert.Equal(
            ["Directory.Build.targets is a build file other than the root props", "MEditService.Box.Tests sets its own bans"],
            BanOffenders(solution, ["MEditService.Box.Tests"]).Order(StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("<ItemGroup><AdditionalFiles Remove=\"@(AdditionalFiles)\" /></ItemGroup>")]
    [InlineData("<ItemGroup><PackageReference Remove=\"@(PackageReference)\" /></ItemGroup>")]
    [InlineData("<Import Project=\"Bans.props\" />")]
    [InlineData("<Choose><When Condition=\"'$(OS)' == 'Windows_NT'\"><ItemGroup><AdditionalFiles Include=\"BannedSymbols.txt\" /></ItemGroup></When></Choose>")]
    [InlineData("<Target Name=\"Late\"><ItemGroup><AdditionalFiles Include=\"BannedSymbols.txt\" /></ItemGroup></Target>")]
    public void TheBanCheck_RefusesPropsItCannotRead(string planted)
    {
        using var solution = new ScratchDirectory("medit-ban-check-");
        ScratchFiles.Plant(solution, "Directory.Build.props", $"<Project>{planted}</Project>");

        Assert.Throws<InvalidOperationException>(() => BanOffenders(solution, ["MEditService.Commands"]));
    }

    private static string[] BanFilesFor(string project) =>
        ServiceProjects.IsTestSide(project) ? [TimeAndBlockingBan]
        : HoldersOfLiveMutagenObjects.Contains(project) ? [SyncOverAsyncBan, TimeAndBlockingBan]
        : [MutagenBan, SyncOverAsyncBan, TimeAndBlockingBan];

    private static List<string> BanOffenders(string solution, IReadOnlyList<string> projects)
    {
        var props = XDocument.Load(Path.Combine(solution, "Directory.Build.props"));
        if (props.Descendants("Import").Concat(props.Descendants("Choose")).Any()
            || props.Descendants("AdditionalFiles").Concat(props.Descendants("PackageReference"))
                .Any(item => item.Attribute("Include") is null || item.Parent?.Parent != props.Root))
            throw new InvalidOperationException(
                "Directory.Build.props imports, chooses, removes or updates an item, or adds one inside a target; the ban check reads only an Include in a top-level item group.");
        return
        [
            .. projects
                .Select(project => (Project: project, Expected: BanFilesFor(project), Bound: BindingIn(props, project)))
                .Where(bound => !bound.Bound.SequenceEqual([Analyzer, .. bound.Expected]))
                .Select(bound => $"{bound.Project} compiles against {string.Join(", ", bound.Bound)}, not {string.Join(", ", [Analyzer, .. bound.Expected])}"),
            .. projects
                .Where(project => File.Exists(ServiceProjects.Csproj(solution, project))
                    && File.ReadAllText(ServiceProjects.Csproj(solution, project)) is var csproj
                    && ProjectBanNeedles.Any(needle => csproj.Contains(needle, StringComparison.Ordinal)))
                .Select(project => $"{project} sets its own bans"),
            .. SourceTree.Files(solution, "Directory.Build.*")
                .Select(file => SourceTree.Relative(solution, file))
                .Where(file => file != "Directory.Build.props" && !file.StartsWith("vendor/", StringComparison.Ordinal))
                .Select(file => $"{file} is a build file other than the root props"),
        ];
    }

    private static List<string> BindingIn(XDocument props, string project)
    {
        var properties = PropertiesOf(props, project);
        bool Binds(XElement item) => Holds(item, properties) && Holds(item.Parent.Require(), properties);
        return
        [
            .. props.Descendants("PackageReference").Where(item => (string?)item.Attribute("Include") == Analyzer && Binds(item)).Select(_ => Analyzer),
            .. props.Descendants("AdditionalFiles").Where(Binds)
                .Select(item => Path.GetFileName(Expand(item.Attribute("Include").Require().Value, properties)))
                .Where(file => file.StartsWith("BannedSymbols", StringComparison.Ordinal))
                .Order(StringComparer.Ordinal),
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
}
