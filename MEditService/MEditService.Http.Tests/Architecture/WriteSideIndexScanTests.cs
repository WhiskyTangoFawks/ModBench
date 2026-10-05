using System.Reflection;
using System.Text.RegularExpressions;
using MEditService.Index;
using MEditService.Queries;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class WriteSideIndexScanTests
{
    private static readonly string[] Symbols =
    [
        "DuckDbRecordIndex", "DuckDbRecordIndexFactory", "Reconciler", "Projector", "FailedReads", "FilterInForce",
        "IRecordReads", "Indexer", "IQueryIndex", "Store", "IndexWriteGate",
        "IRecordQueryService", "RecordQueryService", "MalformedPluginQueryService",
        "IWorldspaceQueryService", "WorldspaceQueryService", "ContainerChildQueryService",
        "FormKeyResolutionCache", "PlacementWalker",
    ];

    private static readonly string[] WholeProductionProjectsExceptTheCompositionRoot =
    [
        "MEditService.Codec", "MEditService.Commands", "MEditService.Index", "MEditService.LoadOrder",
        "MEditService.PluginAdapter", "MEditService.Ports", "MEditService.Queries",
        "MEditService.SourceAdapter",
    ];

    private static readonly string[] IndexItselfAndTheReadSideWhichNameTheseTypesByDefinition =
        ["MEditService.Index", "MEditService.Queries"];

    [Fact]
    public void TheWriteSide_NamesNoIndexType_BecauseItWritesSourceTextAndReadsNothingBack()
    {
        var counts = Counts(ArchitectureTests.SolutionDirectory(), WholeProductionProjectsExceptTheCompositionRoot, IndexItselfAndTheReadSideWhichNameTheseTypesByDefinition, Symbols);

        Assert.True(
            counts.Count == 0,
            "Index types named on the write side — the write side writes source text and reads nothing "
            + "back from the Index:\n"
            + string.Join("\n", counts));
    }

    [Fact]
    public void TheScan_WalksMoreThanFiftyProductionFiles()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, WholeProductionProjectsExceptTheCompositionRoot, IndexItselfAndTheReadSideWhichNameTheseTypesByDefinition).Count;

        Assert.True(walked > 50, $"The write side scan walked only {walked} files under {string.Join(", ", WholeProductionProjectsExceptTheCompositionRoot)}.");
    }

    [Fact]
    public void TheWriteSideSuites_BuildNoIndex()
    {
        var counts = Counts(ArchitectureTests.SolutionDirectory(), ["MEditService.Commands.Tests/Edits"], [], ["new Indexer"]);

        Assert.True(
            counts.Count == 0,
            "Write-side suites that build an Index — a write test that builds an Index is a test of the "
            + "projection, not of the write:\n"
            + string.Join("\n", counts));
    }

    [Fact]
    public void TheScan_CountsPerFileAndSymbol_AndSkipsBuildOutputAndAnExcludedSubtree()
    {
        var root = Directory.CreateTempSubdirectory("medit-write-side-index-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Edits", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Edits", "EditService.cs"),
                "IRecordReads reads = index.Reads!;\nvar rows = reads.Search(query);\n");
            File.WriteAllText(Path.Combine(root, "Edits", "Factory.cs"), "new DuckDbRecordIndexFactory();");
            File.WriteAllText(Path.Combine(root, "Edits", "obj", "Generated.cs"), "DuckDbRecordIndex index;");
            File.WriteAllText(Path.Combine(root, "Edits", "Clean.cs"), "repository.Put(plugin, document);");
            Directory.CreateDirectory(Path.Combine(root, "Records"));
            File.WriteAllText(Path.Combine(root, "Records", "Store.cs"), "DuckDbRecordIndex index;");

            var counts = Counts(root, [""], ["Records"], Symbols);

            Assert.Equal(
                [
                    "Edits/EditService.cs: IRecordReads: 1",
                    "Edits/Factory.cs: DuckDbRecordIndexFactory: 1",
                ],
                counts);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private const string EndpointRoot = "MEditService.Http/Endpoints";

    private static string[] IndexTypesAnEndpointCannotNameByTheirOwnWord() =>
        [.. typeof(IQueryIndex).Assembly.GetExportedTypes().Concat(InternalTypesOfTheIndex()).Select(SourceName)
            .Except(typeof(IRecordQueryService).Assembly.GetExportedTypes().Select(SourceName), StringComparer.Ordinal)
            .Append("MEditService.Index")
            .Append(@"Index\.[A-Z]\w*")
            .Distinct(StringComparer.Ordinal)];

    private static IEnumerable<Type> InternalTypesOfTheIndex() =>
        typeof(IQueryIndex).Assembly.GetTypes().Where(t => !t.IsVisible && !t.IsNested && char.IsLetter(t.Name[0]));

    private static IEnumerable<Type> SignatureTypes(Type type) =>
        type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .SelectMany(m => m.GetParameters().Select(p => p.ParameterType).Append(m.ReturnType))
            .Concat(type.GetProperties().Select(p => p.PropertyType));

    private static IEnumerable<Type> Unwrapped(Type type) =>
        type.GetElementType() is { } element ? Unwrapped(element)
        : type.IsGenericType ? type.GetGenericArguments().SelectMany(Unwrapped).Append(type.GetGenericTypeDefinition())
        : [type];

    private static string SourceName(Type type) => type.Name.Split('`')[0];

    [Fact]
    public void NoQueryService_HandsBackAnIndexType()
    {
        var leaked = typeof(IRecordQueryService).Assembly.GetExportedTypes()
            .SelectMany(SignatureTypes)
            .SelectMany(Unwrapped)
            .Where(t => t.Assembly == typeof(IQueryIndex).Assembly)
            .Select(t => t.FullName)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(
            leaked.Count == 0,
            "A query service's public surface carries an Index type. Queries hide the read model's "
            + "types (ADR-0014): the face answers in its own:\n" + string.Join("\n", leaked));
    }

    [Fact]
    public void NoEndpoint_NamesAnIndexType()
    {
        var root = ArchitectureTests.SolutionDirectory();
        var forbidden = IndexTypesAnEndpointCannotNameByTheirOwnWord();

        var walked = ScannedFiles(root, [EndpointRoot], []).Count;
        var named = Counts(root, [EndpointRoot], [], forbidden);

        Assert.True(walked > 5, $"The endpoint scan walked only {walked} files under {EndpointRoot}.");
        Assert.Contains("Indexer", forbidden);
        Assert.True(
            named.Count == 0,
            "An endpoint names the Index. A route takes a gesture's handler or a query service: "
            + "Queries are the only readers of the read model (ADR-0014), and no arrow runs from the "
            + "HTTP endpoints to the Index:\n"
            + string.Join("\n", named));
    }

    private static readonly string[] UndrawnCallees = ["SourceRepository"];

    [Fact]
    public void NoEndpoint_NamesTheSourceRepository()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, [EndpointRoot], []).Count;
        var named = Counts(root, [EndpointRoot], [], UndrawnCallees);

        Assert.True(walked > 5, $"The endpoint scan walked only {walked} files under {EndpointRoot}.");
        Assert.True(
            named.Count == 0,
            "An endpoint names the Source repository. No arrow is drawn from the HTTP endpoints to "
            + "it; resolution under the load order is Commands' to hide:\n"
            + string.Join("\n", named));
    }

    private static List<string> Counts(
        string root, string[] scannedRoots, string[] excludedRoots, string[] symbols) =>
        [.. ScannedFiles(root, scannedRoots, excludedRoots)
            .SelectMany(file => References(File.ReadAllText(file), symbols)
                .Select(r => $"{Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/')}: {r.Symbol}: {r.Count}"))
            .Order(StringComparer.Ordinal)];

    private static List<string> ScannedFiles(string root, string[] scannedRoots, string[] excludedRoots)
    {
        var excluded = excludedRoots
            .Select(r => Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar)) + Path.DirectorySeparatorChar)
            .ToList();

        return [.. scannedRoots
            .SelectMany(r => SourceTree.CSharpFiles(Path.Combine(root, r.Replace('/', Path.DirectorySeparatorChar))))
            .Where(file => !excluded.Exists(e => file.StartsWith(e, StringComparison.Ordinal)))];
    }

    private static IEnumerable<(string Symbol, int Count)> References(string text, string[] symbols) =>
        symbols
            .Select(symbol => (Symbol: symbol, Count: Regex.Count(text, $@"\b{symbol}\b")))
            .Where(r => r.Count > 0);
}
