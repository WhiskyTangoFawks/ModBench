using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
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

        // #296/#305: capture the origin each method actually resolved (or was explicitly given)
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
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) => [];
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
    }

    private sealed class StubSession(IRecordReads repo, IGameSession? session = null) : ISessionManager
    {
        public IGameSession? Session => session;
        public IRecordReads? Repository => repo;
        // #415: read-side double — the worldspace queries never write to the index.
        public IRecordIndex? Index => null;
        // #274: these stubs never load, so they are always in the no-session state.
        public SessionStatus Status => SessionStatus.None;
        public void Load(string d, string p, GameRelease g) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string n, string p, string o) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin) => throw new NotSupportedException();
        public Task ReindexPlugin(string p) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> p) => throw new NotSupportedException();
        public void SetFilter(string s) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
    }

    // #296: a minimal fake session whose Plugins list is real enough to exercise
    // PluginOriginResolver.Resolve — used only by the origin-resolution plumbing test below.
    private sealed class StubGameSession(IReadOnlyList<PluginMetadata> plugins) : IGameSession
    {
        public string DataFolderPath => "";
        public GameRelease GameRelease => GameRelease.Fallout4;
        public IReadOnlyList<PluginMetadata> Plugins => plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName, string origin) => null;
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }

    private static WorldspaceQueryService Service(IReadOnlyList<CellLocationSummary> cells) =>
        new(new StubSession(new StubReader(cells)));

    [Fact]
    public void GetWorldspaceBlocks_GroupsCellsIntoBlocksAndSubBlocks()
    {
        var svc = Service([
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 12, -5),
            new CellLocationSummary("bbb:M.esp", "CellB", 0, 0, 1, 1, 13, -4),
            new CellLocationSummary("ccc:M.esp", "CellC", 1, 0, 0, 0, 40, 2),
        ]);

        var result = svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp");

        Assert.Null(result.TopCell);
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

    // Regression (#173): GetWorldspaces queried table "worldspace", but the schema's real table
    // name — like every other spatial type ("cell", "refr", "achr") — is the raw record
    // signature lowercased ("wrld"). The StubReader above ignores its table-name argument, so it
    // can't catch this; this test runs against a real DuckDbRecordIndex (via the committed
    // cut-down Fallout4.esm fixture) so a wrong table name surfaces as a real failure.
    [Fact]
    public void GetWorldspaces_RealRepository_ReturnsCommonwealthWorldspace()
    {
        using var fixture = new CutDownPluginFixture();
        var svc = new WorldspaceQueryService(new StubSession(fixture.Repo));

        var result = svc.GetWorldspaces(CutDownPluginFixture.PluginFileName);

        Assert.Contains(result, w => w.EditorId == "Commonwealth");
    }

    [Fact]
    public void WorldspaceQuery_NoSession_ThrowsInvalidOperation()
    {
        // No session loaded → Repository is null → a clear InvalidOperationException, not an NRE.
        var svc = new WorldspaceQueryService(new StubSession(null!));
        Assert.Throws<InvalidOperationException>(() => svc.GetInteriorCells("M.esp", 50, 0));
    }

    [Fact]
    public void GetWorldspaces_MapsRecordsToSummaries()
    {
        var reader = new StubReader([], [
            new RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA", "Data"),
            new RecordSummary("0002:M.esp", "M.esp", 0, true, null, "Data"),
        ]);
        var svc = new WorldspaceQueryService(new StubSession(reader));

        var result = svc.GetWorldspaces("M.esp");

        Assert.Equal(2, result.Count);
        Assert.Equal("0001:M.esp", result[0].FormKey);
        Assert.Equal("WorldA", result[0].EditorId);
        Assert.Null(result[1].EditorId);
    }

    // #296: GetWorldspaces called repo.GetRecords("wrld", plugin, ...) with no origin at all — the
    // same class of bug as the other worldspace-tree reads, just one hop further away (through
    // GetRecords rather than a repository method GetWorldspaceCells/GetInteriorCells/
    // GetCellReferences own directly). Verifies the plumbing resolves the session's real origin for
    // the plugin and passes it down, independent of DuckDB.
    [Fact]
    public void GetWorldspaces_ResolvesRealOriginFromSession_AndPassesItToGetRecords()
    {
        var reader = new StubReader([]);
        var session = new StubGameSession([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA"),
        ]);
        var svc = new WorldspaceQueryService(new StubSession(reader, session));

        svc.GetWorldspaces("M.esp");

        Assert.Equal("ModA", reader.LastSearchOrigin);
    }

    // #305: a caller that already knows which copy it's browsing (a tree row built from a
    // specific origin) states it explicitly, and that must win over whatever the load order would
    // otherwise resolve — the same shape RecordQueryService.GetRecords already has (#34). The
    // session here resolves "M.esp" to "ModA", so a passing "ModB" through only proves the
    // explicit value, not the fallback, actually reached GetRecords.
    [Fact]
    public void GetWorldspaces_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var session = new StubGameSession([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA"),
        ]);
        var svc = new WorldspaceQueryService(new StubSession(reader, session));

        svc.GetWorldspaces("M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastSearchOrigin);
    }

    [Fact]
    public void GetWorldspaceBlocks_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var session = new StubGameSession([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA"),
        ]);
        var svc = new WorldspaceQueryService(new StubSession(reader, session));

        svc.GetWorldspaceBlocks("M.esp", "wrld:M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastGetWorldspaceCellsOrigin);
    }

    [Fact]
    public void GetInteriorCells_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var session = new StubGameSession([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA"),
        ]);
        var svc = new WorldspaceQueryService(new StubSession(reader, session));

        svc.GetInteriorCells("M.esp", 50, 0, origin: "ModB");

        Assert.Equal("ModB", reader.LastGetInteriorCellsOrigin);
    }

    // #305: the only prior coverage of GetInteriorCells with an omitted origin
    // (WorldspaceQuery_NoSession_ThrowsInvalidOperation, above) only proves the no-session guard —
    // it asserts nothing about real content flowing through with the load-order-resolved origin.
    // Mirrors GetWorldspaces_MapsRecordsToSummaries so the omitted-origin path stays pinned by a
    // real assertion, not just "it doesn't throw", once GetInteriorCells takes an optional origin.
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

        Assert.NotNull(result.TopCell);
        Assert.Equal("TopCell", result.TopCell!.EditorId);
        Assert.Single(result.Blocks);
    }
}
