using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class WorldspaceTreeTests : IDisposable
{
    private const string PluginName = "M.esp";
    private static readonly PluginAddress Plugin = new(PluginName, PluginOrigin.DataDirectory);
    private static readonly PluginAddress OtherOrigin = new(PluginName, "ModB");

    private readonly ScatteredFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly Dictionary<string, string> _formKeys = new(StringComparer.Ordinal);

    public WorldspaceTreeTests()
    {
        _fixture = new PluginFixtureBuilder("worldspace-query")
            .WithPlugin(PluginName, mod =>
            {
                var grouped = World(mod, "Grouped");
                Place(grouped, (0, 0), (0, 0), Cell(mod, "CellA"));
                Place(grouped, (0, 0), (1, 1), Cell(mod, "CellB"));
                Place(grouped, (1, 0), (0, 0), Cell(mod, "CellC"));

                var scrambled = World(mod, "Scrambled");
                Place(scrambled, (1, 0), (0, 0), Cell(mod, "ScrambledC"));
                Place(scrambled, (0, 0), (1, 1), Cell(mod, "ScrambledA"));
                Place(scrambled, (0, 1), (0, 0), Cell(mod, "ScrambledD"));
                Place(scrambled, (0, 0), (0, 2), Cell(mod, "ScrambledA3"));
                Place(scrambled, (0, 0), (0, 0), Cell(mod, "ScrambledA2"));

                var withTopCell = World(mod, "WithTopCell");
                withTopCell.TopCell = Cell(mod, "TopCell", name: "Sanctuary Hills");
                Place(withTopCell, (0, 0), (0, 0), Cell(mod, "BlockCell", name: "Concord"));

                var bareCell = new Cell(mod);
                var bareRef = new PlacedObject(mod);
                bareCell.Persistent.Add(bareRef);
                Place(World(mod, "Bare"), (0, 0), (0, 0), bareCell);
                _formKeys["BareCell"] = bareCell.FormKey.ToString();
                _formKeys["BareRef"] = bareRef.FormKey.ToString();

                _formKeys["Unnamed"] = World(mod, editorId: null).FormKey.ToString();

                var placedIn = Cell(mod, "PlacedIn");
                var persistentBase = new Static(mod) { EditorID = "PersistentBase" };
                mod.Statics.Add(persistentBase);
                var temporaryBase = mod.Npcs.AddNew("TemporaryBase");
                var persistent = new PlacedObject(mod) { EditorID = "PersistentEditor" };
                persistent.Base.SetTo(persistentBase);
                placedIn.Persistent.Add(persistent);
                var temporary = new PlacedNpc(mod) { EditorID = "TemporaryEditor" };
                temporary.Base.SetTo(temporaryBase);
                placedIn.Temporary.Add(temporary);
                Place(World(mod, "Placing"), (0, 0), (0, 0), placedIn);
                _formKeys["PersistentEditor"] = persistent.FormKey.ToString();
                _formKeys["TemporaryEditor"] = temporary.FormKey.ToString();
                _formKeys["PersistentBase"] = persistentBase.FormKey.ToString();
                _formKeys["TemporaryBase"] = temporaryBase.FormKey.ToString();
                _formKeys["PlacedIn"] = placedIn.FormKey.ToString();
            })
            .BuildScattered();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private Worldspace World(Fallout4Mod mod, string? editorId)
    {
        var world = new Worldspace(mod) { EditorID = editorId };
        mod.Worldspaces.Add(world);
        if (editorId is not null) _formKeys[editorId] = world.FormKey.ToString();
        return world;
    }

    private Cell Cell(Fallout4Mod mod, string editorId, string? name = null)
    {
        var cell = new Cell(mod) { EditorID = editorId, Name = name };
        _formKeys[editorId] = cell.FormKey.ToString();
        return cell;
    }

    private static void Place(Worldspace world, (short X, short Y) block, (short X, short Y) subBlock, Cell cell)
    {
        var held = world.SubCells.FirstOrDefault(b => b.BlockNumberX == block.X && b.BlockNumberY == block.Y);
        if (held is null)
        {
            held = new WorldspaceBlock { BlockNumberX = block.X, BlockNumberY = block.Y };
            world.SubCells.Add(held);
        }
        var heldSub = held.Items.FirstOrDefault(s => s.BlockNumberX == subBlock.X && s.BlockNumberY == subBlock.Y);
        if (heldSub is null)
        {
            heldSub = new WorldspaceSubBlock { BlockNumberX = subBlock.X, BlockNumberY = subBlock.Y };
            held.Items.Add(heldSub);
        }
        heldSub.Items.Add(cell);
    }

    private string FormKeyOf(string editorId) => _formKeys[editorId];

    [Fact]
    public void ACellsChildren_AreSplitIntoPersistentAndTemporary_NamingEachAndItsBase()
    {
        var result = _index.Queries.GetCellChildRecords(Plugin, FormKeyOf("PlacedIn")).Value();

        Assert.Equal(
            new ChildRecordSummary(
                FormKeyOf("PersistentEditor"), "PersistentEditor", FormKeyOf("PersistentBase"), "refr", WorkingTreeState.None,
                BaseEditorId: "PersistentBase"),
            Assert.Single(result.Persistent));
        Assert.Equal(
            new ChildRecordSummary(
                FormKeyOf("TemporaryEditor"), "TemporaryEditor", FormKeyOf("TemporaryBase"), "achr", WorkingTreeState.None,
                BaseEditorId: "TemporaryBase"),
            Assert.Single(result.Temporary));
    }

    [Fact]
    public void AWorldspacesCells_AreGroupedIntoBlocksAndSubBlocks()
    {
        var result = _index.Queries.GetWorldspaceBlocks(Plugin, FormKeyOf("Grouped")).Value();

        Assert.Empty(result.TopCells);
        Assert.Equal(2, result.Blocks.Count);

        var block00 = result.Blocks.Single(b => b is { X: 0, Y: 0 });
        Assert.Equal(2, block00.SubBlocks.Count);
        Assert.Equal("CellA", block00.SubBlocks.Single(s => s is { X: 0, Y: 0 }).Cells.Single().EditorId);
        Assert.Equal("CellB", block00.SubBlocks.Single(s => s is { X: 1, Y: 1 }).Cells.Single().EditorId);
    }

    [Fact]
    public void AWorldspacesBlocksAndSubBlocks_SortAscendingByXThenY_KeepingTwoBlocksSharingXApartByY()
    {
        var result = _index.Queries.GetWorldspaceBlocks(Plugin, FormKeyOf("Scrambled")).Value();

        Assert.Equal([(0, 0), (0, 1), (1, 0)], result.Blocks.Select(b => (b.X, b.Y)));
        Assert.Equal([(0, 0), (0, 2), (1, 1)], result.Blocks[0].SubBlocks.Select(s => (s.X, s.Y)));
    }

    [Fact]
    public void AChildRefWithNoEditorIdOrBase_CarriesNulls()
    {
        var result = _index.Queries.GetCellChildRecords(Plugin, FormKeyOf("BareCell")).Value();

        Assert.Equal(
            new ChildRecordSummary(FormKeyOf("BareRef"), null, null, "refr", WorkingTreeState.None),
            Assert.Single(result.Persistent));
    }

    [Fact]
    public void AWorldspaceCellWithNoEditorIdGridOrFullName_CarriesNulls()
    {
        var result = _index.Queries.GetWorldspaceBlocks(Plugin, FormKeyOf("Bare")).Value();

        var cell = Assert.Single(Assert.Single(Assert.Single(result.Blocks).SubBlocks).Cells);
        Assert.Equal<(string, string?, int?, int?, string?)>(
            (FormKeyOf("BareCell"), null, null, null, null), (cell.FormKey, cell.EditorId, cell.CellX, cell.CellY, cell.FullName));
    }

    [Fact]
    public void AWorldspace_IsListedWithItsEditorId_AnUnnamedOneWithNone()
    {
        var result = _index.Queries.GetWorldspaces(Plugin).Value();

        Assert.Equal("Grouped", result.Single(w => w.FormKey == FormKeyOf("Grouped")).EditorId);
        Assert.Null(result.Single(w => w.FormKey == FormKeyOf("Unnamed")).EditorId);
    }

    [Fact]
    public void AWorldspacesTopCell_IsThePersistentWorldspaceCell_BesideTheBlocks()
    {
        var result = _index.Queries.GetWorldspaceBlocks(Plugin, FormKeyOf("WithTopCell")).Value();

        var topCell = Assert.Single(result.TopCells);
        Assert.Equal("TopCell", topCell.EditorId);
        Assert.True(topCell.IsPersistentWorldspaceCell);
        Assert.Null(topCell.CellX);
        Assert.Null(topCell.CellY);
        Assert.Single(result.Blocks);
    }

    [Fact]
    public void ACellsFullName_IsCarried_ForTopCellsAndBlockCells()
    {
        var result = _index.Queries.GetWorldspaceBlocks(Plugin, FormKeyOf("WithTopCell")).Value();

        Assert.Equal("Sanctuary Hills", result.TopCells[0].FullName);
        Assert.Equal("Concord", result.Blocks[0].SubBlocks[0].Cells[0].FullName);
    }

    private static ScatteredFixtureData TwoOriginsOfOneName() =>
        new PluginFixtureBuilder("worldspace-query-origins")
            .WithPlugin(PluginName, mod => HoldingWorldAndInterior(mod, "InData"))
            .WithPlugin(PluginName, mod => HoldingWorldAndInterior(mod, "InModB"), origin: OtherOrigin.Origin)
            .BuildScattered();

    private static void HoldingWorldAndInterior(Fallout4Mod mod, string editorId)
    {
        Place(mod.Worldspaces.AddNew(editorId), (0, 0), (0, 0), new Cell(mod) { EditorID = editorId });
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(new Cell(mod) { EditorID = editorId });
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    [Fact]
    public void TheWorldspacesListed_AreThoseOfTheGivenOrigin()
    {
        using var fixture = TwoOriginsOfOneName();
        using var index = Indexes.Reconciled(fixture);

        Assert.Equal(["InModB"], index.Queries.GetWorldspaces(OtherOrigin).Value().Select(w => w.EditorId));
        Assert.Empty(index.Queries.GetWorldspaces(Plugin).Value());
    }

    [Fact]
    public void AWorldspacesBlocks_HoldTheCellsOfTheGivenOrigin()
    {
        using var fixture = TwoOriginsOfOneName();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Queries.GetWorldspaceBlocks(OtherOrigin, "000800:M.esp").Value();

        Assert.Equal("InModB", Assert.Single(Assert.Single(Assert.Single(result.Blocks).SubBlocks).Cells).EditorId);
        Assert.Empty(index.Queries.GetWorldspaceBlocks(Plugin, "000800:M.esp").Value().Blocks);
    }

    [Fact]
    public void TheInteriorCells_AreThoseOfTheGivenOrigin()
    {
        using var fixture = TwoOriginsOfOneName();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Queries.GetInteriorCells(OtherOrigin).Value();

        Assert.Equal("InModB", Assert.Single(Assert.Single(Assert.Single(result).SubBlocks).Cells).EditorId);
        Assert.Empty(index.Queries.GetInteriorCells(Plugin).Value());
    }

    [Fact]
    public void ACellsParseFailure_RollsUpItsSubBlockAndBlock_SoACollapsedNodeStillShowsTheErrorBeneathIt()
    {
        using var index = Indexes.Reconciled(_fixture, adapter: new DiagnosingAdapter { Unreadable = FormKeyOf("CellA") });

        var result = index.Queries.GetWorldspaceBlocks(Plugin, FormKeyOf("Grouped")).Value();

        var failing = result.Blocks.Single(b => b is { X: 0, Y: 0 });
        Assert.True(failing.HasParseFailure);
        Assert.True(failing.SubBlocks.Single(s => s is { X: 0, Y: 0 }).HasParseFailure);
        Assert.True(failing.SubBlocks.Single(s => s is { X: 0, Y: 0 }).Cells.Single().HasParseFailure);
        Assert.False(failing.SubBlocks.Single(s => s is { X: 1, Y: 1 }).HasParseFailure);

        var clean = result.Blocks.Single(b => b is { X: 1, Y: 0 });
        Assert.False(clean.HasParseFailure);
        Assert.False(clean.SubBlocks.Single().HasParseFailure);
    }

    [Fact]
    public void OnlyTheWorldspaceTheIndexFindsAFailureBeneath_IsMarked()
    {
        using var index = Indexes.Reconciled(_fixture, adapter: new DiagnosingAdapter { Unreadable = FormKeyOf("CellA") });

        var result = index.Queries.GetWorldspaces(Plugin).Value();

        Assert.True(result.Single(w => w.FormKey == FormKeyOf("Grouped")).HasParseFailure);
        Assert.False(result.Single(w => w.FormKey == FormKeyOf("Scrambled")).HasParseFailure);
    }
}
