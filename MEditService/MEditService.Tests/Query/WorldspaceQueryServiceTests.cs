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
        CellReferences? cellRefs = null) : IRecordReader
    {
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey, string origin) => cells;

        // #296: captures the origin GetWorldspaces actually resolved and passed down, so the
        // plumbing (not just the repository-level filter) is verified independently of DuckDB.
        public string? LastGetRecordsOrigin { get; private set; }

        public PagedResult<RecordSummary> GetRecords(string t, string? p, string? s, int l, int o, string? origin = null)
        {
            LastGetRecordsOrigin = origin;
            return new(records ?? [], (records ?? []).Count);
        }
        public RecordDetail? GetRecord(string t, string fk, string? p, string? origin, bool w) => null;
        public IReadOnlyList<RecordDetail> GetAllOverrides(string t, string fk) => [];
        public VmadData? GetVmad(string fk, string p, string origin) => null;
        public IReadOnlyList<ConditionOwner> GetConditions(string fk, string p, string origin) => [];
        public int CountRecordsForPlugin(string t, string p, string origin) => 0;
        public string? FindRecordType(string fk) => null;
        public RecordLookupEntry? ResolveFormKey(string fk) => null;
        public IReadOnlyList<string> GetNativeFormKeys(string plugin, string origin) => [];
        public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> t, string? p, string? s, int l, int o, string? origin = null) => new([], 0);
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<string>();
        public IReadOnlyList<ReferenceResult> GetReferences(string fk) => [];
        public PagedResult<CellSummary> GetInteriorCells(string p, int l, int o, string origin) => new([], 0);
        public CellReferences GetCellReferences(string p, string fk, string origin) => cellRefs ?? new([], []);
        public PlacementRow? GetPlacement(string formKey, string plugin, string origin) => null;
    }

    private sealed class StubSession(IRecordReader repo, IGameSession? session = null) : ISessionManager
    {
        public IGameSession? Session => session;
        public IRecordReader? Repository => repo;
        public void Load(string d, string p, GameRelease g) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<(string Name, string Path, string Origin, bool Participates)> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string n) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string p, IReadOnlyList<PendingChange> c) => throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string p, IReadOnlyList<PendingChange> c) => throw new NotSupportedException();
        public Task ReindexPlugin(string p) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> p) => throw new NotSupportedException();
        public string ReserveFormKey(string p) => throw new NotSupportedException();
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
        new(new StubSession(new StubReader(cells)), DuckDbTestFactory.MakePendingChangeService());

    private static WorldspaceQueryService ServiceWithChanges(
        IPendingChangeService changes,
        CellReferences? committedRefs = null) =>
        new(new StubSession(new StubReader([], cellRefs: committedRefs)), changes);

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
    // can't catch this; this test runs against a real DuckDbRecordRepository (via the committed
    // cut-down Fallout4.esm fixture) so a wrong table name surfaces as a real failure.
    [Fact]
    public void GetWorldspaces_RealRepository_ReturnsCommonwealthWorldspace()
    {
        using var fixture = new CutDownPluginFixture();
        var svc = new WorldspaceQueryService(new StubSession(fixture.Repo), DuckDbTestFactory.MakePendingChangeService());

        var result = svc.GetWorldspaces(CutDownPluginFixture.PluginFileName);

        Assert.Contains(result, w => w.EditorId == "Commonwealth");
    }

    [Fact]
    public void WorldspaceQuery_NoSession_ThrowsInvalidOperation()
    {
        // No session loaded → Repository is null → a clear InvalidOperationException, not an NRE.
        var svc = new WorldspaceQueryService(new StubSession(null!), DuckDbTestFactory.MakePendingChangeService());
        Assert.Throws<InvalidOperationException>(() => svc.GetInteriorCells("M.esp", 50, 0));
    }

    [Fact]
    public void GetWorldspaces_MapsRecordsToSummaries()
    {
        var reader = new StubReader([], [
            new RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA", "Data"),
            new RecordSummary("0002:M.esp", "M.esp", 0, true, null, "Data"),
        ]);
        var svc = new WorldspaceQueryService(new StubSession(reader), DuckDbTestFactory.MakePendingChangeService());

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
        var svc = new WorldspaceQueryService(new StubSession(reader, session), DuckDbTestFactory.MakePendingChangeService());

        svc.GetWorldspaces("M.esp");

        Assert.Equal("ModA", reader.LastGetRecordsOrigin);
    }

    [Fact]
    public void GetCellReferences_PendingCreated_AppearsUnderCell_InCorrectGroup()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(new PendingChangeUpsert("1234:Patch.esp", "Patch.esp", "refr",
            new() { [PendingChangeConstants.CreateFieldPath] = PendingChangeConstants.NullElement },
            "user", null, [],
            ChangeType: PendingChangeConstants.CreateChangeType,
            ParentCell: "cell:Fallout4.esm", PlacementGroup: PendingChangeConstants.PlacementGroupPersistent, FormRefs: null, Origin: "Data"));

        var result = ServiceWithChanges(changes).GetCellReferences("Patch.esp", "cell:Fallout4.esm");

        Assert.Single(result.Persistent);
        Assert.Equal("1234:Patch.esp", result.Persistent[0].FormKey);
        Assert.Empty(result.Temporary);
    }

    // #296: StubSession.Session is null, so ResolveOrigin("Patch.esp") always falls back to the
    // reserved PluginOrigin.DataDirectory ("Data") — a real non-Data origin ("ModA") on the staged
    // change therefore must NOT overlay here. Before this fix, the pending-overlay lookup called
    // _changes.GetChanges(plugin) with no origin argument at all, so it overlaid every origin's
    // pending edits onto any requested plugin — this ModA-origin create would incorrectly appear
    // under a "Data"-origin read.
    [Fact]
    public void GetCellReferences_PendingOverlay_ScopesToResolvedOrigin_ExcludesOtherOriginPendingCreate()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(new PendingChangeUpsert("9999:Patch.esp", "Patch.esp", "refr",
            new() { [PendingChangeConstants.CreateFieldPath] = PendingChangeConstants.NullElement },
            "user", null, [],
            ChangeType: PendingChangeConstants.CreateChangeType,
            ParentCell: "cell:Fallout4.esm", PlacementGroup: PendingChangeConstants.PlacementGroupPersistent, FormRefs: null, Origin: "ModA"));

        var result = ServiceWithChanges(changes).GetCellReferences("Patch.esp", "cell:Fallout4.esm");

        Assert.Empty(result.Persistent);
    }

    [Fact]
    public void GetCellReferences_PendingDeleted_IsHidden()
    {
        var committed = new CellReferences([new PlacedSummary("dead:Mod.esp", null, null, "refr")], []);
        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(new PendingChangeUpsert("dead:Mod.esp", "Mod.esp", "refr",
            new() { [PendingChangeConstants.DeleteFieldPath] = PendingChangeConstants.NullElement },
            "user", null, [],
            ChangeType: PendingChangeConstants.DeleteChangeType,
            ParentCell: "cell:Fallout4.esm", FormRefs: null, PlacementGroup: null, Origin: "Data"));

        var result = ServiceWithChanges(changes, committed).GetCellReferences("Mod.esp", "cell:Fallout4.esm");

        Assert.Empty(result.Persistent);
    }

    [Fact]
    public void GetCellReferences_CopiedRef_AppearsUnderTargetCell_NotOtherCell()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(new PendingChangeUpsert("5678:Patch.esp", "Patch.esp", "refr",
            new() { [PendingChangeConstants.CreateFieldPath] = PendingChangeConstants.NullElement },
            "user", null, [],
            ChangeType: PendingChangeConstants.CreateChangeType,
            ParentCell: "target:Fallout4.esm", PlacementGroup: PendingChangeConstants.PlacementGroupTemporary, FormRefs: null, Origin: "Data"));

        var svc = ServiceWithChanges(changes);

        Assert.Empty(svc.GetCellReferences("Patch.esp", "other:Fallout4.esm").Temporary);
        Assert.Single(svc.GetCellReferences("Patch.esp", "target:Fallout4.esm").Temporary);
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
