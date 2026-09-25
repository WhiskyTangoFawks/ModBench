using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public class WorldspaceQueryServiceTests
{
    // A repository stub returning a fixed set of cell-location rows, exercising the service's
    // block / sub-block grouping logic.
    private sealed class StubReader(
        IReadOnlyList<CellLocationSummary> cells,
        IReadOnlyList<RecordSummary>? records = null,
        CellReferences? cellRefs = null,
        IReadOnlySet<string>? failedWorldspaces = null) : IRecordReads
    {
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey)
        {
            LastGetWorldspaceCellsOrigin = plugin.Origin;
            return cells;
        }

        // Capture the origin each method actually resolved (or was explicitly given)
        // and passed down, so the plumbing (not just the repository-level filter) is verified
        // independently of DuckDB.
        public string? LastSearchOrigin { get; private set; }
        public string? LastGetWorldspaceCellsOrigin { get; private set; }
        public string? LastGetInteriorCellsOrigin { get; private set; }
        public string? LastGetCellReferencesOrigin { get; private set; }

        public PagedResult<RecordSummary> Search(RecordQuery query)
        {
            LastSearchOrigin = query.Origin;
            return new(records ?? [], (records ?? []).Count);
        }
        public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins =>
            new Dictionary<PluginAddress, PluginContent>();
        public RecordDocument? GetDocument(string formKey) => null;
        public RecordDocument? GetDocument(string formKey, PluginAddress plugin) => null;
        public IReadOnlyList<RecordDocument> GetDocuments(PluginAddress plugin) => [];
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin) => [];
        public RecordLookupEntry? Resolve(string formKey) => null;
        public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<PluginAddress>();
        public IReadOnlySet<string> GetPluginsWithParseFailures() => new HashSet<string>();
        public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses() => [];
        public IReadOnlySet<PluginAddress> GetTrackedPlugins() => new HashSet<PluginAddress>(PluginAddress.Comparer);
        public IReadOnlySet<string> GetWorldspacesWithFailuresBelow(PluginAddress p) => failedWorldspaces ?? new HashSet<string>();
        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => [];
        public IReadOnlyList<string> GetNativeFormKeys(PluginAddress plugin) => [];
        public PagedResult<CellSummary> GetInteriorCells(PluginAddress plugin, int l, int o)
        {
            LastGetInteriorCellsOrigin = plugin.Origin;
            return new(cells.Select(c => new CellSummary(c.FormKey, c.EditorId, c.CellX, c.CellY)).ToList(), cells.Count);
        }
        public CellReferences GetCellReferences(PluginAddress plugin, string fk)
        {
            LastGetCellReferencesOrigin = plugin.Origin;
            return cellRefs ?? new([], []);
        }
        public PlacementRow? GetPlacement(string formKey, PluginAddress plugin) => null;
        public CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey) => null;
        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey) => [];
        public ContainerChildRow? GetContainerParent(PluginAddress plugin, string childFormKey) => null;
    }

    // The reads' presence is what "no load order" means for the Index side; this service takes
    // the load order itself from the holder.
    private sealed class StubIndex(IRecordReads reads) : IQueryIndex
    {
        // These stubs never project, so they are always in the no-load-order state and unfiltered.
        public LoadOrderStatus Status => LoadOrderStatus.None;
        public string? FilterSql => null;
        public IRecordReads RequireReads() => reads ?? throw new NoLoadOrderException();
    }

    private static LoadOrderHolder Holder(params RegisteredPlugin[] copies)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, copies));
        return holder;
    }

    private static RegisteredPlugin Copy(string name, string origin) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), Slot: 0, Enabled: true, Winning: true);

    private static WorldspaceQueryService Service(IReadOnlyList<CellLocationSummary> cells) =>
        new(new StubIndex(new StubReader(cells)), Holder());

    [Fact]
    public void GetWorldspaceBlocks_GroupsCellsIntoBlocksAndSubBlocks()
    {
        var svc = Service([
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 12, -5),
            new CellLocationSummary("bbb:M.esp", "CellB", 0, 0, 1, 1, 13, -4),
            new CellLocationSummary("ccc:M.esp", "CellC", 1, 0, 0, 0, 40, 2),
        ]);

        var result = svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp");

        Assert.Empty(result.TopCells);
        Assert.Equal(2, result.Blocks.Count);

        var block00 = result.Blocks.Single(b => b is { X: 0, Y: 0 });
        Assert.Equal(2, block00.SubBlocks.Count);
        Assert.Equal("CellA", block00.SubBlocks.Single(s => s is { X: 0, Y: 0 }).Cells.Single().EditorId);
        Assert.Equal("CellB", block00.SubBlocks.Single(s => s is { X: 1, Y: 1 }).Cells.Single().EditorId);
    }

    [Fact]
    public void GetWorldspaceBlocks_SortsBlocksAndSubBlocksAscendingByXThenY()
    {
        // Scrambled input across two blocks sharing X=0 but differing in Y, plus a separate X=1 block, so
        // BlockY has to participate in grouping and keep the two X=0 blocks distinct.
        var svc = Service([
            new CellLocationSummary("c1:M.esp", "CellC", 1, 0, 0, 0, 40, 2),
            new CellLocationSummary("a1:M.esp", "CellA", 0, 0, 1, 1, 1, 1),
            new CellLocationSummary("d1:M.esp", "CellD", 0, 1, 0, 0, 2, 2),
            new CellLocationSummary("a3:M.esp", "CellA3", 0, 0, 0, 2, 3, 3),
            new CellLocationSummary("a2:M.esp", "CellA2", 0, 0, 0, 0, 4, 4),
        ]);

        var result = svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp");

        // Three distinct blocks, ascending by (X, Y): (0,0), (0,1), (1,0).
        Assert.Equal(
            [(0, 0), (0, 1), (1, 0)],
            result.Blocks.Select(b => (b.X, b.Y)).ToArray());

        // Sub-blocks within block (0,0) ascending by (X, Y): (0,0), (0,2), (1,1).
        var block00 = result.Blocks[0];
        Assert.Equal(
            [(0, 0), (0, 2), (1, 1)],
            block00.SubBlocks.Select(s => (s.X, s.Y)).ToArray());
    }

    [Fact]
    public void WorldspaceQuery_NoLoadOrder_ThrowsInvalidOperation()
    {
        // The reads are there; what is missing is a snapshot in the kernel, and that alone must
        // produce a clear NoLoadOrderException rather than a read against the reserved origin.
        var svc = new WorldspaceQueryService(new StubIndex(new StubReader([])), new LoadOrderHolder());
        Assert.Throws<NoLoadOrderException>(() => svc.GetInteriorCells("M.esp", 50, 0));
    }

    [Fact]
    public void GetWorldspaces_MapsRecordsToSummaries()
    {
        var reader = new StubReader([], [
            new RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA", "Data"),
            new RecordSummary("0002:M.esp", "M.esp", 0, true, null, "Data"),
        ]);
        var svc = new WorldspaceQueryService(new StubIndex(reader), Holder());

        var result = svc.GetWorldspaces("M.esp");

        Assert.Equal(2, result.Count);
        Assert.Equal("0001:M.esp", result[0].FormKey);
        Assert.Equal("WorldA", result[0].EditorId);
        Assert.Null(result[1].EditorId);
    }

    // GetWorldspaces must not call GetRecords with no origin: the same class of bug as the other
    // worldspace-tree reads, one hop further away. Verifies the plumbing resolves the load order's
    // real origin and passes it down, independent of DuckDB.
    [Fact]
    public void GetWorldspaces_ResolvesRealOriginFromLoadOrder_AndPassesItToGetRecords()
    {
        var reader = new StubReader([]);
        var svc = new WorldspaceQueryService(new StubIndex(reader), Holder(Copy("M.esp", "ModA")));

        svc.GetWorldspaces("M.esp");

        Assert.Equal("ModA", reader.LastSearchOrigin);
    }

    // A caller that already knows which copy it is browsing states it explicitly, and that must win
    // over what the load order would resolve.
    [Fact]
    public void GetWorldspaces_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var svc = new WorldspaceQueryService(new StubIndex(reader), Holder(Copy("M.esp", "ModA")));

        svc.GetWorldspaces("M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastSearchOrigin);
    }

    [Fact]
    public void GetWorldspaceBlocks_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var svc = new WorldspaceQueryService(new StubIndex(reader), Holder(Copy("M.esp", "ModA")));

        svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastGetWorldspaceCellsOrigin);
    }

    [Fact]
    public void GetInteriorCells_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var svc = new WorldspaceQueryService(new StubIndex(reader), Holder(Copy("M.esp", "ModA")));

        svc.GetInteriorCells("M.esp", 50, 0, origin: "ModB");

        Assert.Equal("ModB", reader.LastGetInteriorCellsOrigin);
    }

    // The omitted-origin path stays pinned by a real assertion, not just "it doesn't throw" —
    // WorldspaceQuery_NoLoadOrder_ThrowsInvalidOperation above only proves the no-load-order guard
    // and asserts nothing about real content flowing through with the load-order-resolved origin.
    [Fact]
    public void GetInteriorCells_OmittedOrigin_ReturnsRealContent()
    {
        var svc = Service([
            new CellLocationSummary("int:M.esp", "IntCell", null, null, null, null, 0, 0),
        ]);

        var result = svc.GetInteriorCells("M.esp", 50, 0);

        Assert.Single(result.Items);
        Assert.Equal("IntCell", result.Items[0].EditorId);
    }

    [Fact]
    public void GetWorldspaceBlocks_NullBlockCell_IsTreatedAsTopCell()
    {
        var svc = Service([
            new CellLocationSummary("top:M.esp", "TopCell", null, null, null, null, 0, 0),
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1),
        ]);

        var result = svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp");

        Assert.Single(result.TopCells);
        Assert.Equal("TopCell", result.TopCells[0].EditorId);
        Assert.True(result.TopCells[0].IsPersistentWorldspaceCell);
        Assert.Single(result.Blocks);
    }

    // Picking the first block-less row as TopCell and building Blocks only from rows with block
    // coordinates leaves a second block-less row in neither: real runtime data loss.
    [Fact]
    public void GetWorldspaceBlocks_TwoBlocklessCellRows_SurfacesBoth()
    {
        var svc = Service([
            new CellLocationSummary("first:M.esp", "FirstBlockless", null, null, null, null, 0, 0),
            new CellLocationSummary("second:M.esp", "SecondBlockless", null, null, null, null, 0, 0),
        ]);

        var result = svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp");

        Assert.Equal(2, result.TopCells.Count);
        Assert.Equal(new string?[] { "FirstBlockless", "SecondBlockless" }, result.TopCells.Select(c => c.EditorId).ToArray());
        Assert.True(result.TopCells[0].IsPersistentWorldspaceCell);
        Assert.False(result.TopCells[1].IsPersistentWorldspaceCell);
    }

    // The repository row carries a FULL name independently of grid coordinates and persistence, so this
    // pins that GetWorldspaceBlocks forwards it into both CellSummary construction sites.
    [Fact]
    public void GetWorldspaceBlocks_ForwardsFullNameOntoCellSummary_ForTopCellsAndBlockCells()
    {
        var svc = Service([
            new CellLocationSummary("top:M.esp", "TopCell", null, null, null, null, 0, 0, "Sanctuary Hills"),
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1, "Concord"),
        ]);

        var result = svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp");

        Assert.Equal("Sanctuary Hills", result.TopCells[0].FullName);
        Assert.Equal("Concord", result.Blocks[0].SubBlocks[0].Cells[0].FullName);
    }
    // The tree's "has a failure below it": a cell row's own flag reaches its sub-block and its
    // block, so a collapsed node still shows the error beneath it.
    [Fact]
    public void GetWorldspaceBlocks_RollsACellsParseFailureUpItsSubBlockAndBlock()
    {
        var svc = Service([
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1, null, HasParseFailure: true),
            new CellLocationSummary("bbb:M.esp", "CellB", 1, 0, 0, 0, 2, 2),
        ]);

        var result = svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp");

        var failing = result.Blocks.Single(b => b is { X: 0, Y: 0 });
        Assert.True(failing.HasParseFailure);
        Assert.True(failing.SubBlocks.Single().HasParseFailure);
        Assert.True(failing.SubBlocks.Single().Cells.Single().HasParseFailure);

        var clean = result.Blocks.Single(b => b is { X: 1, Y: 0 });
        Assert.False(clean.HasParseFailure);
        Assert.False(clean.SubBlocks.Single().HasParseFailure);
    }

    [Fact]
    public void GetWorldspaces_MarksOnlyTheWorldspaceWithAFailureBelowIt()
    {
        var reader = new StubReader([], [
            new RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA", "Data"),
            new RecordSummary("0002:M.esp", "M.esp", 0, true, "WorldB", "Data"),
        ], failedWorldspaces: new HashSet<string>(StringComparer.Ordinal) { "0001:M.esp" });
        var svc = new WorldspaceQueryService(new StubIndex(reader), Holder());

        var result = svc.GetWorldspaces("M.esp");

        Assert.True(result.Single(w => w.FormKey == "0001:M.esp").HasParseFailure);
        Assert.False(result.Single(w => w.FormKey == "0002:M.esp").HasParseFailure);
    }
}
