using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
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
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey) => cells;

        public PagedResult<RecordSummary> GetRecords(string t, string? p, string? s, int l, int o) =>
            new(records ?? [], (records ?? []).Count);
        public RecordDetail? GetRecord(string t, string fk, string? p, bool w) => null;
        public IReadOnlyList<RecordDetail> GetAllOverrides(string t, string fk) => [];
        public VmadData? GetVmad(string fk, string p) => null;
        public int CountRecordsForPlugin(string t, string p) => 0;
        public string? FindRecordType(string fk) => null;
        public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> t, string? p, string? s, int l, int o) => new([], 0);
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<string>();
        public IReadOnlyList<ReferenceResult> GetReferences(string fk) => [];
        public PagedResult<CellSummary> GetInteriorCells(string p, int l, int o) => new([], 0);
        public CellReferences GetCellReferences(string p, string fk) => cellRefs ?? new([], []);
        public PlacementRow? GetPlacement(string formKey, string plugin) => null;
    }

    private sealed class StubSession(IRecordReader repo) : ISessionManager
    {
        public IGameSession? Session => null;
        public IRecordReader? Repository => repo;
        public void Load(string d, string p, GameRelease g) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<(string Name, string Path)> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string n) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string p, IReadOnlyList<PendingChange> c) => throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string p, IReadOnlyList<PendingChange> c) => throw new NotSupportedException();
        public Task ReindexPlugin(string p) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> p) => throw new NotSupportedException();
        public string ReserveFormKey(string p) => throw new NotSupportedException();
        public void SetFilter(string s) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
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
            new RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA"),
            new RecordSummary("0002:M.esp", "M.esp", 0, true, null),
        ]);
        var svc = new WorldspaceQueryService(new StubSession(reader), DuckDbTestFactory.MakePendingChangeService());

        var result = svc.GetWorldspaces("M.esp");

        Assert.Equal(2, result.Count);
        Assert.Equal("0001:M.esp", result[0].FormKey);
        Assert.Equal("WorldA", result[0].EditorId);
        Assert.Null(result[1].EditorId);
    }

    [Fact]
    public void GetCellReferences_PendingCreated_AppearsUnderCell_InCorrectGroup()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(new PendingChangeUpsert("1234:Patch.esp", "Patch.esp", "refr",
            new() { [PendingChangeConstants.CreateFieldPath] = PendingChangeConstants.NullElement },
            "user", null, [],
            ChangeType: PendingChangeConstants.CreateChangeType,
            ParentCell: "cell:Fallout4.esm", PlacementGroup: PendingChangeConstants.PlacementGroupPersistent));

        var result = ServiceWithChanges(changes).GetCellReferences("Patch.esp", "cell:Fallout4.esm");

        Assert.Single(result.Persistent);
        Assert.Equal("1234:Patch.esp", result.Persistent[0].FormKey);
        Assert.Empty(result.Temporary);
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
            ParentCell: "cell:Fallout4.esm"));

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
            ParentCell: "target:Fallout4.esm", PlacementGroup: PendingChangeConstants.PlacementGroupTemporary));

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
