using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.RealData;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

public class WorldspaceQueryServiceTests
{
    // A repository stub returning a fixed set of cell-location rows, exercising the service's
    // block / sub-block grouping logic.
    private sealed class StubReader(
        IReadOnlyList<CellLocationSummary> cells,
        IReadOnlyList<RecordSummary>? records = null,
        CellReferences? cellRefs = null) : IRecordReads
    {
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey)
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
            LastSearchOrigin = query.Plugin?.Origin;
            return new(records ?? [], (records ?? []).Count);
        }
        public RecordDocument? GetDocument(string formKey) => null;
        public RecordDocument? GetDocument(string formKey, PluginKey plugin) => null;
        public IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin) => [];
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) => [];
        public IReadOnlyList<string> GetContestedFormKeys() => [];
        public RecordLookupEntry? Resolve(string formKey) => null;
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<string>();
        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => [];
        public IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin) => [];
        public IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin) => [];
        public PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int l, int o)
        {
            LastGetInteriorCellsOrigin = plugin.Origin;
            return new(cells.Select(c => new CellSummary(c.FormKey, c.EditorId, c.CellX, c.CellY)).ToList(), cells.Count);
        }
        public CellReferences GetCellReferences(PluginKey plugin, string fk)
        {
            LastGetCellReferencesOrigin = plugin.Origin;
            return cellRefs ?? new([], []);
        }
        public PlacementRow? GetPlacement(string formKey, PluginKey plugin) => null;
        public CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) => null;
        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey) => [];
        public ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) => null;
    }

    private sealed class StubMirror(IRecordReads repo, ILoadOrder? loadOrder = null) : ILoadOrderMirror
    {
        public ILoadOrder? LoadOrder => loadOrder;
        public IRecordReads? Reads => repo;
        // Read-side double — the worldspace queries never write to the index.
        public IRecordIndex? Index => null;
        // These stubs never load, so they are always in the no-load-order state.
        public LoadOrderStatus Status => LoadOrderStatus.None;
        // This double's own tests only ever exercise the Reads/RequireReads() side — loadOrder
        // defaults to null in most of them, which would make a real "both null together"
        // RequireScope() check throw where RequireRepository() never used to. Gating on repo
        // alone keeps that (repo's presence is what "no load order" means for these tests, same
        // as the RequireRepository() it replaces), while repo is null (the one test that wants
        // the throw) still throws regardless of loadOrder.
        public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() =>
            repo is { } r ? (loadOrder!, r) : throw new NoLoadOrderException();
        public void Reconcile(string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease, string? instanceRoot = null) => throw new NotSupportedException();
        public void Close() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string n, string p, string o) => throw new NotSupportedException();
        public Task ReindexPlugin(PluginKey key) => throw new NotSupportedException();
        public void UnindexPlugin(PluginKey key) => throw new NotSupportedException();
        public void SetFilter(string s) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
        public void ReapplyFilter() => throw new NotSupportedException();
    }

    // A minimal fake load order whose Plugins list is real enough to exercise
    // PluginOriginResolver.Resolve — used only by the origin-resolution plumbing test below.
    private sealed class StubLoadOrder(IReadOnlyList<PluginMetadata> plugins) : ILoadOrder
    {
        public string DataFolderPath => "";
        public string? InstanceRoot => null;
        public GameRelease GameRelease => GameRelease.Fallout4;
        public IReadOnlyList<PluginMetadata> Plugins => plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName, string origin) => null;
        public void Dispose() { }
    }

    private static WorldspaceQueryService Service(IReadOnlyList<CellLocationSummary> cells) =>
        new(new StubMirror(new StubReader(cells)));

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
        // Scrambled input across two blocks that share X=0 but differ in Y, plus a separate X=1
        // block. Asserts both the block ordering and the sub-block ordering are ascending — and
        // that BlockY participates in grouping (the two X=0 blocks must stay distinct).
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

    // Regression: a GetWorldspaces querying table "worldspace" misses — the schema's real table
    // name, like every other spatial type ("cell", "refr", "achr"), is the raw record
    // signature lowercased ("wrld"). The StubReader above ignores its table-name argument, so it
    // can't catch this; this test runs against a real DuckDbRecordIndex (via the committed
    // cut-down Fallout4.esm fixture) so a wrong table name surfaces as a real failure.
    [Fact]
    public void GetWorldspaces_RealRepository_ReturnsCommonwealthWorldspace()
    {
        using var fixture = new CutDownPluginFixture();
        var svc = new WorldspaceQueryService(new StubMirror(fixture.Repo));

        var result = svc.GetWorldspaces(CutDownPluginFixture.PluginFileName);

        Assert.Contains(result, w => w.EditorId == "Commonwealth");
    }

    [Fact]
    public void WorldspaceQuery_NoLoadOrder_ThrowsInvalidOperation()
    {
        // No load order held → Reads is null → a clear NoLoadOrderException, not an NRE.
        var svc = new WorldspaceQueryService(new StubMirror(null!));
        Assert.Throws<NoLoadOrderException>(() => svc.GetInteriorCells("M.esp", 50, 0));
    }

    [Fact]
    public void GetWorldspaces_MapsRecordsToSummaries()
    {
        var reader = new StubReader([], [
            new RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA", "Data"),
            new RecordSummary("0002:M.esp", "M.esp", 0, true, null, "Data"),
        ]);
        var svc = new WorldspaceQueryService(new StubMirror(reader));

        var result = svc.GetWorldspaces("M.esp");

        Assert.Equal(2, result.Count);
        Assert.Equal("0001:M.esp", result[0].FormKey);
        Assert.Equal("WorldA", result[0].EditorId);
        Assert.Null(result[1].EditorId);
    }

    // GetWorldspaces must not call repo.GetRecords("wrld", plugin, ...) with no origin — the
    // same class of bug as the other worldspace-tree reads, just one hop further away (through
    // GetRecords rather than a repository method GetWorldspaceCells/GetInteriorCells/
    // GetCellReferences own directly). Verifies the plumbing resolves the load order's real origin for
    // the plugin and passes it down, independent of DuckDB.
    [Fact]
    public void GetWorldspaces_ResolvesRealOriginFromLoadOrder_AndPassesItToGetRecords()
    {
        var reader = new StubReader([]);
        var loadOrder = new StubLoadOrder([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA", Enabled: true, Winning: true),
        ]);
        var svc = new WorldspaceQueryService(new StubMirror(reader, loadOrder));

        svc.GetWorldspaces("M.esp");

        Assert.Equal("ModA", reader.LastSearchOrigin);
    }

    // A caller that already knows which copy it's browsing (a tree row built from a
    // specific origin) states it explicitly, and that must win over whatever the load order would
    // otherwise resolve — the same shape RecordQueryService.GetRecords already has. The
    // load order here resolves "M.esp" to "ModA", so a passing "ModB" through only proves the
    // explicit value, not the fallback, actually reached GetRecords.
    [Fact]
    public void GetWorldspaces_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var loadOrder = new StubLoadOrder([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA", Enabled: true, Winning: true),
        ]);
        var svc = new WorldspaceQueryService(new StubMirror(reader, loadOrder));

        svc.GetWorldspaces("M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastSearchOrigin);
    }

    [Fact]
    public void GetWorldspaceBlocks_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var loadOrder = new StubLoadOrder([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA", Enabled: true, Winning: true),
        ]);
        var svc = new WorldspaceQueryService(new StubMirror(reader, loadOrder));

        svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastGetWorldspaceCellsOrigin);
    }

    [Fact]
    public void GetInteriorCells_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var loadOrder = new StubLoadOrder([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA", Enabled: true, Winning: true),
        ]);
        var svc = new WorldspaceQueryService(new StubMirror(reader, loadOrder));

        svc.GetInteriorCells("M.esp", 50, 0, origin: "ModB");

        Assert.Equal("ModB", reader.LastGetInteriorCellsOrigin);
    }

    // The omitted-origin path stays pinned by a real assertion, not just "it doesn't throw" —
    // WorldspaceQuery_NoLoadOrder_ThrowsInvalidOperation above only proves the no-load-order
    // guard and asserts nothing about real content flowing through with the load-order-resolved
    // origin. Mirrors GetWorldspaces_MapsRecordsToSummaries.
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

    // A GetWorldspaceBlocks that picks the *first* block-less row as TopCell and builds Blocks
    // only from rows that have block coordinates leaves a second block-less row in neither —
    // silently dropped (real runtime data loss, not just theory).
    // Both rows must be reachable, with only the first flagged as the persistent cell.
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

    // GetWorldspaceCells's repository row carries a FULL name independently of grid
    // coordinates / persistence — this pins that GetWorldspaceBlocks actually forwards it into both
    // CellSummary construction sites (TopCells and a block/sub-block's Cells) rather than dropping
    // it on the floor. The tree-provider label precedence itself is a frontend concern; this only
    // proves the DTO field survives this hop.
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
}
