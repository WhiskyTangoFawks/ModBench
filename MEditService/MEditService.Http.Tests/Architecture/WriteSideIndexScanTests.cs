using System.Reflection;
using System.Text.RegularExpressions;
using MEditService.Index;
using MEditService.Queries;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>The write side names no Index type (ADR-0015 invariants 1, 2, 3 and 5): it writes
/// source text, and what the Index holds is asked for on the read side. Counted against an
/// allowlist that stays empty.</summary>
public sealed class WriteSideIndexScanTests
{
    // The store and its factory, the read surface, the ref enum, the Index, the query surface, the
    // five query services and the write gate. Naming one is how a write path starts reading its own
    // effect.
    private static readonly string[] Symbols =
    [
        "IRecordIndex", "IRecordIndexFactory", "DuckDbRecordIndex", "DuckDbRecordIndexFactory",
        "IRecordReads", "RecordRef", "Indexer", "IQueryIndex", "Store", "IndexWriteGate",
        "IRecordQueryService", "RecordQueryService", "MalformedPluginQueryService",
        "IWorldspaceQueryService", "WorldspaceQueryService", "ContainerChildQueryService",
        "FormKeyResolutionCache", "PlacementWalker",
    ];

    // Whole projects, not folders inside them: a folder literal means a new folder joins the write
    // side unguarded. The composition root and the watcher are not the write side and are not here.
    private static readonly string[] ProductionRoots =
    [
        "MEditService.Codec", "MEditService.Commands", "MEditService.Index", "MEditService.LoadOrder",
        "MEditService.PluginAdapter", "MEditService.Ports", "MEditService.Queries",
        "MEditService.SourceAdapter",
    ];

    // Not write side: Records is the Index module itself and Queries is the read side, both of which
    // name these types by definition.
    private static readonly string[] NotWriteSide =
        ["MEditService.Index", "MEditService.Queries"];

    private const string AllowlistPath = "MEditService.Http.Tests/Architecture/write-side-index-allowlist.txt";

    [Fact]
    public void TheWriteSide_NamesAnIndexType_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ArchitectureTests.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ProductionRoots, NotWriteSide, Symbols),
            SourceTree.ReadAllowlist(Path.Combine(root, AllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            AllowlistPath);
    }

    // An empty allowlist and zero symbols found are the same string: this is what tells them apart,
    // so a ProductionRoots or exclusion typo that scans nothing cannot pass by matching nothing.
    [Fact]
    public void TheScan_WalksMoreThanFiftyProductionFiles()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, ProductionRoots, NotWriteSide).Count;

        Assert.True(walked > 50, $"The write side scan walked only {walked} files under {string.Join(", ", ProductionRoots)}.");
    }

    // The write side's own suites, which would otherwise keep the shape the production code no
    // longer has: a write test that builds an Index is a test of the projection, not of the write.
    private const string TestAllowlistPath = "MEditService.Http.Tests/Architecture/write-side-test-index-allowlist.txt";

    [Fact]
    public void TheWriteSideSuites_BuildAnIndex_OnlyAsOftenAsTheAllowlistSays()
    {
        var root = ArchitectureTests.SolutionDirectory();

        AssertCountsMatchAllowlist(
            Counts(root, ["MEditService.Commands.Tests/Edits"], [], ["new Indexer"]),
            SourceTree.ReadAllowlist(Path.Combine(root, TestAllowlistPath.Replace('/', Path.DirectorySeparatorChar))),
            TestAllowlistPath);
    }

    [Fact]
    public void TheScan_CountsPerFileAndSymbol_AndNamesANewReferenceAndADeletedOne()
    {
        var root = Directory.CreateTempSubdirectory("medit-write-side-index-scan-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "Edits", "obj"));
            File.WriteAllText(
                Path.Combine(root, "Edits", "EditService.cs"),
                "IRecordReads reads = index.Reads!;\nvar rows = reads.At(RecordRef.Effective);\n");
            // The longer name is its own symbol: a prefix match would count it as the interface too.
            File.WriteAllText(Path.Combine(root, "Edits", "Factory.cs"), "new IRecordIndexFactory();");
            File.WriteAllText(Path.Combine(root, "Edits", "obj", "Generated.cs"), "IRecordIndex index;");
            File.WriteAllText(Path.Combine(root, "Edits", "Clean.cs"), "repository.Put(plugin, document);");
            // An excluded subtree is skipped whole, not file by file.
            Directory.CreateDirectory(Path.Combine(root, "Records"));
            File.WriteAllText(Path.Combine(root, "Records", "Store.cs"), "IRecordIndex index;");

            var counts = Counts(root, [""], ["Records"], Symbols);

            Assert.Equal(
                [
                    "Edits/EditService.cs: IRecordReads: 1",
                    "Edits/EditService.cs: RecordRef: 1",
                    "Edits/Factory.cs: IRecordIndexFactory: 1",
                ],
                counts);

            var newReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, ["Edits/Factory.cs: IRecordIndexFactory: 1"], AllowlistPath));
            Assert.Contains("Edits/EditService.cs: IRecordReads: 1", newReference.Message, StringComparison.Ordinal);

            var deletedReference = Assert.Throws<Xunit.Sdk.TrueException>(
                () => AssertCountsMatchAllowlist(counts, [.. counts, "Edits/Gone.cs: Indexer: 4"], AllowlistPath));
            Assert.Contains("Edits/Gone.cs: Indexer: 4", deletedReference.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // The endpoints are a write-side root too: a route that reads the Index and hands the answer to
    // a handler is the write side reading its own effect through the API.
    private const string EndpointRoot = "MEditService.Http/Endpoints";

    // The rebuild's refusal is the Index's own exception, and it crosses Queries' RebuildStore
    // unchanged (ADR-0009 invariant 5), so no signature carries it.
    private static readonly string[] IndexTypesQueriesThrow = ["IndexHeldElsewhereException"];

    // Read off the assemblies, so a type the Index adds is forbidden the day it lands. What a query
    // service's own members take or answer crosses the endpoint as it is.
    private static string[] IndexTypesNoQuerySignatureCarries() =>
        [.. typeof(Indexer).Assembly.GetExportedTypes().Select(SourceName)
            .Except(typeof(IRecordQueryService).Assembly.GetExportedTypes()
                .SelectMany(SignatureTypes)
                .SelectMany(Unwrapped)
                .Select(SourceName), StringComparer.Ordinal)
            .Except(IndexTypesQueriesThrow, StringComparer.Ordinal)
            .Distinct(StringComparer.Ordinal)];

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
    public void NoEndpoint_NamesAnIndexType_ButWhatAQueryServiceHandsIt()
    {
        var root = ArchitectureTests.SolutionDirectory();
        var forbidden = IndexTypesNoQuerySignatureCarries();

        var walked = ScannedFiles(root, [EndpointRoot], []).Count;
        var named = Counts(root, [EndpointRoot], [], forbidden);

        Assert.True(walked > 5, $"The endpoint scan walked only {walked} files under {EndpointRoot}.");
        Assert.Contains("Indexer", forbidden);
        Assert.True(
            named.Count == 0,
            "An endpoint names an Index type no query service hands it. A route takes a gesture's "
            + "handler or a query service: Queries are the only readers of the read model (ADR-0014 "
            + "invariant 3), and no arrow runs from the HTTP endpoints to the Index:\n"
            + string.Join("\n", named));
    }

    // The endpoints reference the Source repository and the watcher as the composition root, and
    // call neither: a route's one call is to a handler or a query service.
    private static readonly string[] UndrawnCallees =
        ["SourceRepository", "ModFolderWatcher", "WatchSet", "ModWatch"];

    [Fact]
    public void NoEndpoint_NamesTheSourceRepositoryOrTheWatcher()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, [EndpointRoot], []).Count;
        var named = Counts(root, [EndpointRoot], [], UndrawnCallees);

        Assert.True(walked > 5, $"The endpoint scan walked only {walked} files under {EndpointRoot}.");
        Assert.True(
            named.Count == 0,
            "An endpoint names the Source repository or the Mod watcher. Neither arrow is drawn from "
            + "the HTTP endpoints; resolution under the load order is Commands' to hide, and the "
            + "watcher is told nothing:\n"
            + string.Join("\n", named));
    }

    private static void AssertCountsMatchAllowlist(
        IReadOnlyList<string> counts, IReadOnlyList<string> allowlist, string allowlistPath)
    {
        var unallowed = counts.Except(allowlist, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var unmatched = allowlist.Except(counts, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();

        Assert.True(
            unallowed.Count == 0 && unmatched.Count == 0,
            $"Index types named on the write side differ from {allowlistPath}.\n"
            + $"Counts the allowlist does not name ({unallowed.Count}) — the write side writes source "
            + "text and reads nothing back from the Index, so a reference here needs the maintainer's "
            + "ruling before its line is added:\n"
            + string.Join("\n", unallowed)
            + $"\nAllowlist lines matching no count ({unmatched.Count}) — delete them; every line here "
            + "is a deliberate exception:\n"
            + string.Join("\n", unmatched));
    }

    // A count, not a line number: a reference is the unit of work, and a line number would fail the
    // gate for any unrelated edit above one.
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
