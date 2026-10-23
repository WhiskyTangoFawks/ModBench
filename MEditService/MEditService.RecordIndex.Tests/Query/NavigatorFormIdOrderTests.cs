using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class NavigatorFormIdOrderTests : IDisposable
{
    private const string PluginName = "Listed.esp";
    private static readonly PluginAddress Plugin = new(PluginName, PluginOrigin.DataDirectory);

    private readonly ScatteredFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly Dictionary<string, string> _formKeys = new(StringComparer.Ordinal);

    public NavigatorFormIdOrderTests()
    {
        _fixture = new PluginFixtureBuilder("navigator-form-id-order")
            .WithPlugin(PluginName, mod =>
            {
                var zuluWorld = new Worldspace(mod) { EditorID = "ZuluWorld" };
                var alphaWorld = new Worldspace(mod) { EditorID = "AlphaWorld" };
                mod.Worldspaces.Add(alphaWorld);
                mod.Worldspaces.Add(zuluWorld);
                _formKeys["ZuluWorld"] = zuluWorld.FormKey.ToString();
                var zuluClearing = new Cell(mod) { EditorID = "ZuluClearing", Grid = new CellGrid { Point = new P2Int(1, 1) } };
                zuluClearing.Temporary.Add(new PlacedObject(mod) { EditorID = "ClearingRef" });
                var alphaClearing = new Cell(mod) { EditorID = "AlphaClearing", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                var exteriorSubBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                exteriorSubBlock.Items.Add(alphaClearing);
                exteriorSubBlock.Items.Add(zuluClearing);
                var exteriorBlock = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                exteriorBlock.Items.Add(exteriorSubBlock);
                zuluWorld.SubCells.Add(exteriorBlock);

                var zuluRoom = new Cell(mod) { EditorID = "ZuluRoom" };
                var alphaRoom = new Cell(mod) { EditorID = "AlphaRoom" };
                var zuluRef = new PlacedObject(mod) { EditorID = "ZuluRef" };
                var alphaRef = new PlacedObject(mod) { EditorID = "AlphaRef" };
                zuluRoom.Temporary.Add(alphaRef);
                zuluRoom.Temporary.Add(zuluRef);
                _formKeys["ZuluRoom"] = zuluRoom.FormKey.ToString();
                var roomSubBlock = new CellSubBlock { BlockNumber = 7 };
                roomSubBlock.Cells.Add(alphaRoom);
                roomSubBlock.Cells.Add(zuluRoom);
                var roomBlock = new CellBlock { BlockNumber = 3 };
                roomBlock.SubBlocks.Add(roomSubBlock);

                var otherSubBlock = new CellSubBlock { BlockNumber = 0 };
                otherSubBlock.Cells.Add(new Cell(mod) { EditorID = "OtherRoom" });
                var otherBlock = new CellBlock { BlockNumber = 0 };
                otherBlock.SubBlocks.Add(otherSubBlock);

                mod.Cells.Records.Add(roomBlock);
                mod.Cells.Records.Add(otherBlock);
            })
            .BuildScattered();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IReadOnlyList<CellSummary> ExteriorCells() =>
        _index.Queries.GetWorldspaceBlocks(Plugin, _formKeys["ZuluWorld"]).Value().Blocks[0].SubBlocks[0].Cells;

    [Fact]
    public void Worldspaces_ListInFormIdOrder_NotEditorIdOrder()
    {
        var result = _index.Queries.GetWorldspaces(Plugin).Value();

        Assert.Equal(["ZuluWorld", "AlphaWorld"], result.Select(w => w.EditorId));
    }

    [Fact]
    public void Worldspaces_SayWhetherAnyCellIsBeneathThem()
    {
        var result = _index.Queries.GetWorldspaces(Plugin).Value();

        Assert.Equal([true, false], result.Select(w => w.HasChildren));
    }

    [Fact]
    public void ASubBlocksCells_ListInFormIdOrder_NotEditorIdOrder()
    {
        Assert.Equal(["ZuluClearing", "AlphaClearing"], ExteriorCells().Select(c => c.EditorId));
    }

    [Fact]
    public void AnExteriorCell_SaysWhetherItHoldsAPlacedReference()
    {
        Assert.Equal([true, false], ExteriorCells().Select(c => c.HasChildren));
    }

    [Fact]
    public void InteriorCells_AnswerAsTheBlocksAndSubBlocksTheFileHoldsThemIn_InFormIdOrder()
    {
        var blocks = _index.Queries.GetInteriorCells(Plugin).Value();

        Assert.Equal([0, 3], blocks.Select(b => b.Number));
        var subBlock = Assert.Single(blocks[1].SubBlocks);
        Assert.Equal(7, subBlock.Number);
        Assert.Equal(["ZuluRoom", "AlphaRoom"], subBlock.Cells.Select(c => c.EditorId));
    }

    [Fact]
    public void ACellsPlacedReferences_ListInFormIdOrder_NotEditorIdOrder()
    {
        var result = _index.Queries.GetCellChildRecords(Plugin, _formKeys["ZuluRoom"]).Value();

        Assert.Equal(["ZuluRef", "AlphaRef"], result.Temporary.Select(r => r.EditorId));
    }
}
