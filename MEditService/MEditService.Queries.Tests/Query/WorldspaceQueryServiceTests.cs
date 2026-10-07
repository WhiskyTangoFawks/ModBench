using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public class WorldspaceQueryServiceTests
{
    private sealed class StubReader(
        IReadOnlyList<CellLocationSummary> cells,
        IReadOnlyList<Index.RecordSummary>? records = null,
        Index.CellChildRecords? cellRefs = null) : IRecordReads
    {
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey)
        {
            LastGetWorldspaceCellsOrigin = plugin.Origin;
            return cells;
        }

        public string? LastSearchOrigin { get; private set; }
        public string? LastGetWorldspaceCellsOrigin { get; private set; }
        public string? LastGetInteriorCellsOrigin { get; private set; }
        public string? LastGetCellChildRecordsOrigin { get; private set; }

        public Index.PagedResult<Index.RecordSummary> Search(RecordQuery query)
        {
            LastSearchOrigin = query.Origin;
            return new(records ?? [], (records ?? []).Count);
        }
        public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins =>
            new Dictionary<PluginAddress, PluginContent>();
        public RecordDocument? GetDocument(string formKey) => null;
        public RecordDocument? GetDocument(string formKey, PluginAddress plugin) => null;
        public RecordDocument? DocumentFromText(string formKey, PluginAddress plugin, int loadOrderIndex, string text) => null;
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin) => [];
        public RecordLookupEntry? Resolve(string formKey) => null;
        public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<PluginAddress>();
        public IReadOnlySet<string> GetPluginsWithParseFailures() => new HashSet<string>();
        public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses() => [];
        public IReadOnlyDictionary<PluginAddress, DerivedFrom> GetDerivations() => new Dictionary<PluginAddress, DerivedFrom>();
        public IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey) => [];
        public IReadOnlyList<MissingReferenceOnFile> GetReferencesToMissingRecordsOnFiles(Func<PluginAddress, PluginProvider.FromMod?> modOf) => [];
        public IReadOnlyList<CellLocationSummary> GetInteriorCells(PluginAddress plugin)
        {
            LastGetInteriorCellsOrigin = plugin.Origin;
            return cells;
        }
        public IReadOnlySet<string> GetWorldspacesHoldingCells(PluginAddress plugin) => new HashSet<string>();
        public Index.CellChildRecords GetCellChildRecords(PluginAddress plugin, string fk)
        {
            LastGetCellChildRecordsOrigin = plugin.Origin;
            return cellRefs ?? new([], []);
        }
        public CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey) => null;
        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey) => [];
        public bool HasChildRecords(PluginAddress plugin, string formKey) => false;
        public IReadOnlySet<PluginAddress> PluginsHoldingChildRecords(PluginAddress plugin, string formKey) => new HashSet<PluginAddress>();
    }

    private static WorldspaceQueryService Service(IReadOnlyList<CellLocationSummary> cells) =>
        new(new StubIndex(new StubReader(cells)));

    [Fact]
    public void GetCellChildRecords_AnswersEveryChildFact_InQueriesOwnTypes()
    {
        var persistent = new Index.ChildRecordSummary(
            "p1:M.esp", "PersistentEditor", "base1:M.esp", "REFR", HasParseFailure: true,
            FullName: "PersistentFull", BaseEditorId: "PersistentBase", ParseDiagnosis: "persistent diagnosis");
        var temporary = new Index.ChildRecordSummary(
            "t1:M.esp", "TemporaryEditor", "base2:M.esp", "ACHR", HasParseFailure: false,
            FullName: "TemporaryFull", BaseEditorId: "TemporaryBase", ParseDiagnosis: "temporary diagnosis");
        var svc = new WorldspaceQueryService(new StubIndex(new StubReader([], cellRefs: new Index.CellChildRecords([persistent], [temporary]))));

        var result = svc.GetCellChildRecords(new PluginAddress("M.esp", "Data"), "cell:M.esp");

        Assert.Equal(
            new ChildRecordSummary("p1:M.esp", "PersistentEditor", "base1:M.esp", "REFR", true, "PersistentFull", "PersistentBase", "persistent diagnosis"),
            Assert.Single(result.Persistent));
        Assert.Equal(
            new ChildRecordSummary("t1:M.esp", "TemporaryEditor", "base2:M.esp", "ACHR", false, "TemporaryFull", "TemporaryBase", "temporary diagnosis"),
            Assert.Single(result.Temporary));
    }

    [Fact]
    public void GetWorldspaceBlocks_GroupsCellsIntoBlocksAndSubBlocks()
    {
        var svc = Service([
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 12, -5),
            new CellLocationSummary("bbb:M.esp", "CellB", 0, 0, 1, 1, 13, -4),
            new CellLocationSummary("ccc:M.esp", "CellC", 1, 0, 0, 0, 40, 2),
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
            new CellLocationSummary("c1:M.esp", "CellC", 1, 0, 0, 0, 40, 2),
            new CellLocationSummary("a1:M.esp", "CellA", 0, 0, 1, 1, 1, 1),
            new CellLocationSummary("d1:M.esp", "CellD", 0, 1, 0, 0, 2, 2),
            new CellLocationSummary("a3:M.esp", "CellA3", 0, 0, 0, 2, 3, 3),
            new CellLocationSummary("a2:M.esp", "CellA2", 0, 0, 0, 0, 4, 4),
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
        var svc = new WorldspaceQueryService(new StubIndex(reads: null));
        Assert.Throws<NoLoadOrderException>(() => svc.GetInteriorCells(new PluginAddress("M.esp", "Data")));
    }

    [Fact]
    public void GetWorldspaces_MapsRecordsToSummaries()
    {
        var reader = new StubReader([], [
            new Index.RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA", "Data"),
            new Index.RecordSummary("0002:M.esp", "M.esp", 0, true, null, "Data"),
        ]);
        var svc = new WorldspaceQueryService(new StubIndex(reader));

        var result = svc.GetWorldspaces(new PluginAddress("M.esp", "Data"));

        Assert.Equal(2, result.Count);
        Assert.Equal("0001:M.esp", result[0].FormKey);
        Assert.Equal("WorldA", result[0].EditorId);
        Assert.Null(result[1].EditorId);
    }

    [Fact]
    public void GetWorldspaces_PassesGivenOriginToSearch_UntouchedOneHopFurtherThanTheOtherWorldspaceTreeReads()
    {
        var reader = new StubReader([]);
        var svc = new WorldspaceQueryService(new StubIndex(reader));

        svc.GetWorldspaces(new PluginAddress("M.esp", "ModB"));

        Assert.Equal("ModB", reader.LastSearchOrigin);
    }

    [Fact]
    public void GetWorldspaceBlocks_PassesGivenOriginToReads()
    {
        var reader = new StubReader([]);
        var svc = new WorldspaceQueryService(new StubIndex(reader));

        svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "ModB"), "wrld:M.esp");

        Assert.Equal("ModB", reader.LastGetWorldspaceCellsOrigin);
    }

    [Fact]
    public void GetInteriorCells_PassesGivenOriginToReads()
    {
        var reader = new StubReader([]);
        var svc = new WorldspaceQueryService(new StubIndex(reader));

        svc.GetInteriorCells(new PluginAddress("M.esp", "ModB"));

        Assert.Equal("ModB", reader.LastGetInteriorCellsOrigin);
    }

    [Fact]
    public void GetInteriorCells_ReturnsRealContent()
    {
        var svc = Service([
            new CellLocationSummary("int:M.esp", "IntCell", null, null, null, null, 0, 0),
        ]);

        var result = svc.GetInteriorCells(new PluginAddress("M.esp", "Data"));

        Assert.Equal("IntCell", Assert.Single(Assert.Single(Assert.Single(result).SubBlocks).Cells).EditorId);
    }

    [Fact]
    public void GetWorldspaceBlocks_NullBlockCell_IsTreatedAsTopCell()
    {
        var svc = Service([
            new CellLocationSummary("top:M.esp", "TopCell", null, null, null, null, 0, 0),
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1),
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
            new CellLocationSummary("first:M.esp", "FirstBlockless", null, null, null, null, 0, 0),
            new CellLocationSummary("second:M.esp", "SecondBlockless", null, null, null, null, 0, 0),
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
            new CellLocationSummary("top:M.esp", "TopCell", null, null, null, null, 0, 0, "Sanctuary Hills"),
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1, "Concord"),
        ]);

        var result = svc.GetWorldspaceBlocks(new PluginAddress("M.esp", "Data"), "wrld:M.esp");

        Assert.Equal("Sanctuary Hills", result.TopCells[0].FullName);
        Assert.Equal("Concord", result.Blocks[0].SubBlocks[0].Cells[0].FullName);
    }

    [Fact]
    public void GetWorldspaceBlocks_RollsACellsParseFailureUpItsSubBlockAndBlock_SoACollapsedNodeStillShowsTheErrorBeneathIt()
    {
        var svc = Service([
            new CellLocationSummary("aaa:M.esp", "CellA", 0, 0, 0, 0, 1, 1, null, HasParseFailure: true),
            new CellLocationSummary("bbb:M.esp", "CellB", 1, 0, 0, 0, 2, 2),
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
        var reader = new StubReader([], [
            new Index.RecordSummary("0001:M.esp", "M.esp", 0, true, "WorldA", "Data", HasParseFailure: true),
            new Index.RecordSummary("0002:M.esp", "M.esp", 0, true, "WorldB", "Data"),
        ]);
        var svc = new WorldspaceQueryService(new StubIndex(reader));

        var result = svc.GetWorldspaces(new PluginAddress("M.esp", "Data"));

        Assert.True(result.Single(w => w.FormKey == "0001:M.esp").HasParseFailure);
        Assert.False(result.Single(w => w.FormKey == "0002:M.esp").HasParseFailure);
    }
}
