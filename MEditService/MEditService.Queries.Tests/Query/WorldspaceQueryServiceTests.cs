using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public class WorldspaceQueryServiceTests
{
    private static readonly PluginAddress Plugin = new("M.esp", "Data");
    private static readonly PluginAddress OtherOrigin = new("M.esp", "ModB");
    private const string World = "wrld:M.esp";

    private static IWorldspaceQueryService Service(FakeReads reads) => QueryHost.Worldspaces(new StubIndex(reads));

    private static FakeReads Reads(params FakeRow[] rows) => new(new Dictionary<PluginAddress, PluginContent>(), rows);

    private static IWorldspaceQueryService Service(IReadOnlyList<CellLocationSummary> cells) => Service(Holding((Plugin, cells)));

    // Each plugin holds its cells both in the worldspace and as interior cells.
    private static FakeReads Holding(params (PluginAddress Plugin, IReadOnlyList<CellLocationSummary> Cells)[] holdings)
    {
        var reads = Reads();
        reads.WorldspaceCells = holdings.ToDictionary(h => new RecordAt(h.Plugin, World), h => h.Cells);
        reads.InteriorCells = holdings.ToDictionary(h => h.Plugin, h => h.Cells);
        return reads;
    }

    private static CellLocationSummary Cell(string editorId) =>
        new($"{editorId}:M.esp", editorId, 0, 0, 0, 0, 1, 1, Index.WorkingTreeState.None);

    private static FakeRow Worldspace(string formKey, string? editorId, PluginAddress? plugin = null, bool holdsAnUnreadableRecord = false) =>
        new(new RecordDocument(formKey, plugin ?? Plugin, 0, IsWinner: false, editorId, "wrld", null, []),
            HoldsAnUnreadableRecord: holdsAnUnreadableRecord);

    [Fact]
    public void GetCellChildRecords_AnswersEveryChildFact_InQueriesOwnTypes()
    {
        var persistent = new Index.ChildRecordSummary(
            "p1:M.esp", "PersistentEditor", "base1:M.esp", "REFR", Index.WorkingTreeState.Modified, HasParseFailure: true,
            FullName: "PersistentFull", BaseEditorId: "PersistentBase", ParseDiagnosis: "persistent diagnosis");
        var temporary = new Index.ChildRecordSummary(
            "t1:M.esp", "TemporaryEditor", "base2:M.esp", "ACHR", Index.WorkingTreeState.None, HasParseFailure: false,
            FullName: "TemporaryFull", BaseEditorId: "TemporaryBase", ParseDiagnosis: "temporary diagnosis");
        var reads = Reads();
        reads.CellChildren = new Dictionary<RecordAt, Index.CellChildRecords>
        {
            [new RecordAt(Plugin, "cell:M.esp")] = new([persistent], [temporary]),
        };
        var svc = Service(reads);

        var result = svc.GetCellChildRecords(new PluginAddress("M.esp", "Data"), "cell:M.esp");

        Assert.Equal(
            new ChildRecordSummary("p1:M.esp", "PersistentEditor", "base1:M.esp", "REFR", WorkingTreeState.Modified, true, "PersistentFull", "PersistentBase", "persistent diagnosis"),
            Assert.Single(result.Persistent));
        Assert.Equal(
            new ChildRecordSummary("t1:M.esp", "TemporaryEditor", "base2:M.esp", "ACHR", WorkingTreeState.None, false, "TemporaryFull", "TemporaryBase", "temporary diagnosis"),
            Assert.Single(result.Temporary));
    }

    [Fact]
    public void GetWorldspaceBlocks_GroupsCellsIntoBlocksAndSubBlocks()
    {
        var svc = Service([
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 12, -5, Index.WorkingTreeState.None),
            new CellLocationSummary("bbb:M.esp", "CellB", 0, 0, 1, 1, 13, -4, Index.WorkingTreeState.None),
            new CellLocationSummary("ccc:M.esp", "CellC", 1, 0, 0, 0, 40, 2, Index.WorkingTreeState.None),
        ]);

        var result = svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "Data"), "wrld:M.esp");

        Assert.Empty(result.TopCells);
        Assert.Equal(2, result.Blocks.Count);

        var block00 = result.Blocks.Single(b => b is { X: 0, Y: 0 });
        Assert.Equal(2, block00.SubBlocks.Count);
        Assert.Equal("CellA", block00.SubBlocks.Single(s => s is { X: 0, Y: 0 }).Cells.Single().EditorId);
        Assert.Equal("CellB", block00.SubBlocks.Single(s => s is { X: 1, Y: 1 }).Cells.Single().EditorId);
    }

    [Fact]
    public void GetWorldspaceBlocks_SortsBlocksAndSubBlocksAscendingByXThenY_KeepingTwoBlocksSharingXApartByY()
    {
        var svc = Service([
            new CellLocationSummary("c1:M.esp", "CellC", 1, 0, 0, 0, 40, 2, Index.WorkingTreeState.None),
            new CellLocationSummary("a1:M.esp", "CellA", 0, 0, 1, 1, 1, 1, Index.WorkingTreeState.None),
            new CellLocationSummary("d1:M.esp", "CellD", 0, 1, 0, 0, 2, 2, Index.WorkingTreeState.None),
            new CellLocationSummary("a3:M.esp", "CellA3", 0, 0, 0, 2, 3, 3, Index.WorkingTreeState.None),
            new CellLocationSummary("a2:M.esp", "CellA2", 0, 0, 0, 0, 4, 4, Index.WorkingTreeState.None),
        ]);

        var result = svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "Data"), "wrld:M.esp");

        Assert.Equal(
            [(0, 0), (0, 1), (1, 0)],
            result.Blocks.Select(b => (b.X, b.Y)).ToArray());

        var block00 = result.Blocks[0];
        Assert.Equal(
            [(0, 0), (0, 2), (1, 1)],
            block00.SubBlocks.Select(s => (s.X, s.Y)).ToArray());
    }

    [Fact]
    public void GetInteriorCells_NoReads_ThrowsNoLoadOrderException_ForOriginTravelsInFromTheCallerSoTheReadsAreTheOneGuard()
    {
        var svc = QueryHost.Worldspaces(new StubIndex(reads: null));
        Assert.Throws<NoLoadOrderException>(() => svc.GetInteriorCells(new PluginAddress("M.esp", "Data")));
    }

    [Fact]
    public void GetWorldspaces_MapsRecordsToSummaries()
    {
        var svc = Service(Reads(Worldspace("000801:M.esp", "WorldA"), Worldspace("000802:M.esp", null)));

        var result = svc.GetWorldspaces(new PluginAddress("M.esp", "Data"));

        Assert.Equal(2, result.Count);
        Assert.Equal("000801:M.esp", result[0].FormKey);
        Assert.Equal("WorldA", result[0].EditorId);
        Assert.Null(result[1].EditorId);
    }

    [Fact]
    public void GetWorldspaces_ListsTheWorldspacesOfTheGivenOrigin()
    {
        var svc = Service(Reads(Worldspace("000801:M.esp", "InData"), Worldspace("000802:M.esp", "InModB", OtherOrigin)));

        var result = svc.GetWorldspaces(OtherOrigin);

        Assert.Equal(["InModB"], result.Select(w => w.EditorId));
    }

    [Fact]
    public void GetWorldspaceBlocks_ReadsTheCellsOfTheGivenOrigin()
    {
        var svc = Service(Holding((Plugin, [Cell("InData")]), (OtherOrigin, [Cell("InModB")])));

        var result = svc.GetWorldspaceBlocks(OtherOrigin, World);

        Assert.Equal("InModB", Assert.Single(Assert.Single(Assert.Single(result.Blocks).SubBlocks).Cells).EditorId);
    }

    [Fact]
    public void GetInteriorCells_ReadsTheCellsOfTheGivenOrigin()
    {
        var svc = Service(Holding((Plugin, [Cell("InData")]), (OtherOrigin, [Cell("InModB")])));

        var result = svc.GetInteriorCells(OtherOrigin);

        Assert.Equal("InModB", Assert.Single(Assert.Single(Assert.Single(result).SubBlocks).Cells).EditorId);
    }

    [Fact]
    public void GetInteriorCells_ReturnsRealContent()
    {
        var svc = Service([
            new CellLocationSummary("int:M.esp", "IntCell", null, null, null, null, 0, 0, Index.WorkingTreeState.None),
        ]);

        var result = svc.GetInteriorCells(new PluginAddress("M.esp", "Data"));

        Assert.Equal("IntCell", Assert.Single(Assert.Single(Assert.Single(result).SubBlocks).Cells).EditorId);
    }

    [Fact]
    public void GetWorldspaceBlocks_NullBlockCell_IsTreatedAsTopCell()
    {
        var svc = Service([
            new CellLocationSummary("top:M.esp", "TopCell", null, null, null, null, 0, 0, Index.WorkingTreeState.None),
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1, Index.WorkingTreeState.None),
        ]);

        var result = svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "Data"), "wrld:M.esp");

        Assert.Single(result.TopCells);
        Assert.Equal("TopCell", result.TopCells[0].EditorId);
        Assert.True(result.TopCells[0].IsPersistentWorldspaceCell);
        Assert.Single(result.Blocks);
    }

    [Fact]
    public void GetWorldspaceBlocks_TwoBlocklessCellRows_SurfacesBoth_NotLosingTheSecondRow()
    {
        var svc = Service([
            new CellLocationSummary("first:M.esp", "FirstBlockless", null, null, null, null, 0, 0, Index.WorkingTreeState.None),
            new CellLocationSummary("second:M.esp", "SecondBlockless", null, null, null, null, 0, 0, Index.WorkingTreeState.None),
        ]);

        var result = svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "Data"), "wrld:M.esp");

        Assert.Equal(2, result.TopCells.Count);
        Assert.Equal(new string?[] { "FirstBlockless", "SecondBlockless" }, result.TopCells.Select(c => c.EditorId).ToArray());
        Assert.True(result.TopCells[0].IsPersistentWorldspaceCell);
        Assert.False(result.TopCells[1].IsPersistentWorldspaceCell);
    }

    [Fact]
    public void GetWorldspaceBlocks_ForwardsFullNameOntoCellSummary_ForTopCellsAndBlockCells()
    {
        var svc = Service([
            new CellLocationSummary("top:M.esp", "TopCell", null, null, null, null, 0, 0, Index.WorkingTreeState.None, "Sanctuary Hills"),
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1, Index.WorkingTreeState.None, "Concord"),
        ]);

        var result = svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "Data"), "wrld:M.esp");

        Assert.Equal("Sanctuary Hills", result.TopCells[0].FullName);
        Assert.Equal("Concord", result.Blocks[0].SubBlocks[0].Cells[0].FullName);
    }

    [Fact]
    public void GetWorldspaceBlocks_RollsACellsParseFailureUpItsSubBlockAndBlock_SoACollapsedNodeStillShowsTheErrorBeneathIt()
    {
        var svc = Service([
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1, Index.WorkingTreeState.None, null, HasParseFailure: true),
            new CellLocationSummary("bbb:M.esp", "CellB", 1, 0, 0, 0, 2, 2, Index.WorkingTreeState.None),
        ]);

        var result = svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "Data"), "wrld:M.esp");

        var failing = result.Blocks.Single(b => b is { X: 0, Y: 0 });
        Assert.True(failing.HasParseFailure);
        Assert.True(failing.SubBlocks.Single().HasParseFailure);
        Assert.True(failing.SubBlocks.Single().Cells.Single().HasParseFailure);

        var clean = result.Blocks.Single(b => b is { X: 1, Y: 0 });
        Assert.False(clean.HasParseFailure);
        Assert.False(clean.SubBlocks.Single().HasParseFailure);
    }

    [Fact]
    public void GetWorldspaces_MarksOnlyTheWorldspaceTheIndexFindsAFailureBeneath()
    {
        var svc = Service(Reads(Worldspace("000801:M.esp", "WorldA", holdsAnUnreadableRecord: true), Worldspace("000802:M.esp", "WorldB")));

        var result = svc.GetWorldspaces(new PluginAddress("M.esp", "Data"));

        Assert.True(result.Single(w => w.FormKey == "000801:M.esp").HasParseFailure);
        Assert.False(result.Single(w => w.FormKey == "000802:M.esp").HasParseFailure);
    }
}
