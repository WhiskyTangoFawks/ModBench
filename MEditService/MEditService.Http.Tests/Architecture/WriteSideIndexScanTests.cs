using System.Text.RegularExpressions;
using MEditService.Tests.TestSupport;

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
        "IRecordReads", "RecordRef", "IndexProjector", "IQueryIndex", "IndexStore", "IndexWriteGate",
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
        "MEditService.SourceRepo",
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
            Counts(root, ["MEditService.Commands.Tests/Edits"], [], ["new IndexProjector"]),
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
                () => AssertCountsMatchAllowlist(counts, [.. counts, "Edits/Gone.cs: IndexProjector: 4"], AllowlistPath));
            Assert.Contains("Edits/Gone.cs: IndexProjector: 4", deletedReference.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // The endpoints are a write-side root too: a route that reads the Index and hands the answer to
    // a handler is the write side reading its own effect through the API.
    private const string EndpointRoot = "MEditService.Http/Endpoints";

    private static readonly string[] GateSymbols = ["IndexWriteGate", "IndexWriteGateTimeoutException"];

    // The read routes name the query services by definition, and the gate has its own fact below,
    // so what is left is the store, the projector and the read surface.
    private static readonly string[] ReadSideSymbols =
        ["IRecordQueryService", "RecordQueryService", "MalformedPluginQueryService",
         "IWorldspaceQueryService", "WorldspaceQueryService", "ContainerChildQueryService"];

    private static readonly string[] EndpointSymbols =
        [.. Symbols.Except(ReadSideSymbols, StringComparer.Ordinal).Except(GateSymbols, StringComparer.Ordinal)];

    // The one endpoint file that maps the Index's doors, one route each.
    private const string DoorMappingFile = "MEditService.Http/Endpoints/IndexEndpoints.cs";

    // The Index's doors as the zoom-out captions them, by the member each route calls. Registers
    // answers the 404 before validate is asked for a copy nobody holds.
    private static readonly string[] IndexDoors =
    [
        "Status", "RequireReads", "FilterSql", "SetFilter", "ClearFilter", "Sequence",
        "AwaitSequenceAsync", "Registers", "ValidateIndex", "RebuildStore",
    ];

    [Fact]
    public void NoEndpoint_ButTheDoorMapping_NamesAnIndexType()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, [EndpointRoot], []).Count;
        var named = Counts(root, [EndpointRoot], [], EndpointSymbols)
            .Where(count => !count.StartsWith(DoorMappingFile + ":", StringComparison.Ordinal))
            .ToList();

        Assert.True(walked > 5, $"The endpoint scan walked only {walked} files under {EndpointRoot}.");
        Assert.True(
            named.Count == 0,
            "An endpoint names an Index type. A route takes a gesture's handler or a query service, "
            + "and the write side never reads the Index (ADR-0015 invariant 1), so a row reaching a "
            + $"handler through the API is the same read by another door. The Index's own doors are "
            + $"mapped in {DoorMappingFile} alone:\n"
            + string.Join("\n", named));
    }

    // A member outside the doors above is the watcher's signal or the projection's own machinery;
    // a door nobody maps is a route that went missing.
    [Fact]
    public void TheDoorMapping_NamesOnlyTheProjector_AndReachesItOnlyThroughItsDoors()
    {
        var root = ArchitectureTests.SolutionDirectory();
        var text = File.ReadAllText(Path.Combine(root, DoorMappingFile.Replace('/', Path.DirectorySeparatorChar)));

        var named = References(text, EndpointSymbols).Select(r => r.Symbol).ToList();
        var members = Regex.Matches(text, @"\bindex\.(\w+)")
            .Select(m => m.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Equal(["IndexProjector"], named);
        Assert.Equal(IndexDoors.Order(StringComparer.Ordinal), members);
    }

    // The endpoints reference the Source repository and the watcher as the composition root, and
    // call neither: a route's one call is to a handler, a query service or an Index door.
    private static readonly string[] UndrawnCallees =
        ["SourceRepository", "ModFolderWatcher", "WatchSet", "ModWatch", "IRefreshIndex"];

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

    [Fact]
    public void NoEndpoint_NamesTheIndexWriteGate()
    {
        var root = ArchitectureTests.SolutionDirectory();

        var walked = ScannedFiles(root, [EndpointRoot], []).Count;
        var named = Counts(root, [EndpointRoot], [], GateSymbols);

        Assert.True(walked > 5, $"The endpoint scan walked only {walked} files under {EndpointRoot}.");
        Assert.True(
            named.Count == 0,
            "An endpoint names the Index's write gate. A record gesture writes its system of record "
            + "and returns (ADR-0015 invariant 2), so the gate stays the projector's own:\n"
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
