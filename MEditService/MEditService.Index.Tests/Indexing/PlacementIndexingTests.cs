using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Indexing;

public class PlacementIndexingTests
{
    private static readonly PluginAddress Key = new("TestWorld.esp", PluginOrigin.DataDirectory);

    private sealed class Built : IDisposable
    {
        public Built()
        {
            FormKey wrld = default, top = default, ext = default, bare = default, intCell = default, bareInt = default;
            FormKey barrel = default, nullRef = default, raider = default;
            Fixture = new PluginFixtureBuilder("placement")
                .WithPlugin(Key.Name, mod =>
                {
                    var w = mod.Worldspaces.AddNew("CommonwealthTest");

                    var topCell = new Cell(mod) { EditorID = "TopCell" };
                    w.TopCell = topCell;

                    var extCell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(12, -5) } };
                    var barrelRef = new PlacedObject(mod)
                    {
                        EditorID = "barrelRef",
                        Position = new P3Float(10f, 20f, 30f),
                        Base = new FormLinkNullable<IPlaceableObjectGetter>(FormKey.Factory("000ABC:TestWorld.esp")),
                    };
                    var bareRef = new PlacedObject(mod);
                    var raiderRef = new PlacedObject(mod) { EditorID = "raiderRef" };
                    extCell.Persistent.Add(barrelRef);
                    extCell.Persistent.Add(bareRef);
                    extCell.Temporary.Add(raiderRef);

                    var bareCell = new Cell(mod);

                    var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                    subBlock.Items.Add(extCell);
                    var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                    block.Items.Add(subBlock);

                    var subBlock2 = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 1 };
                    subBlock2.Items.Add(bareCell);
                    var block2 = new WorldspaceBlock { BlockNumberX = 1, BlockNumberY = 0 };
                    block2.Items.Add(subBlock2);

                    w.SubCells.Add(block);
                    w.SubCells.Add(block2);

                    var interior = new Cell(mod) { EditorID = "IntCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                    var bareInterior = new Cell(mod);
                    var intSub = new CellSubBlock { BlockNumber = 0 };
                    intSub.Cells.Add(interior);
                    intSub.Cells.Add(bareInterior);
                    var intBlock = new CellBlock { BlockNumber = 0 };
                    intBlock.SubBlocks.Add(intSub);
                    mod.Cells.Records.Add(intBlock);

                    (wrld, top, ext, bare, intCell, bareInt) = (w.FormKey, topCell.FormKey, extCell.FormKey, bareCell.FormKey, interior.FormKey, bareInterior.FormKey);
                    (barrel, nullRef, raider) = (barrelRef.FormKey, bareRef.FormKey, raiderRef.FormKey);
                })
                .Build();
            Index = Indexes.Reconciled(Fixture);
            (WorldspaceFk, TopCellFk, ExtCellFk, BareCellFk, IntCellFk, BareIntCellFk) =
                (wrld.ToString(), top.ToString(), ext.ToString(), bare.ToString(), intCell.ToString(), bareInt.ToString());
            (BarrelFk, NullRefFk, RaiderFk) = (barrel.ToString(), nullRef.ToString(), raider.ToString());
        }

        public PluginFixtureData Fixture { get; }
        public OpenedIndex Index { get; }
        public string WorldspaceFk { get; }
        public string TopCellFk { get; }
        public string ExtCellFk { get; }
        public string BareCellFk { get; }
        public string IntCellFk { get; }
        public string BareIntCellFk { get; }
        public string BarrelFk { get; }
        public string NullRefFk { get; }
        public string RaiderFk { get; }

        public void Dispose()
        {
            Index.Dispose();
            Fixture.Dispose();
        }
    }

    private sealed record CellAt(int? BlockX, int? BlockY, int? SubX, int? SubY, CellSummary Cell);

    private static List<CellAt> WorldspaceCells(OpenedIndex index, PluginAddress plugin, string worldspace)
    {
        var blocks = index.Queries.GetWorldspaceBlocks(plugin, worldspace).Value();
        return
        [
            .. blocks.TopCells.Select(c => new CellAt(null, null, null, null, c)),
            .. blocks.Blocks.SelectMany(b => b.SubBlocks.SelectMany(s => s.Cells.Select(c => new CellAt(b.X, b.Y, s.X, s.Y, c)))),
        ];
    }

    private static List<CellSummary> InteriorCells(OpenedIndex index, PluginAddress plugin) =>
        [.. index.Queries.GetInteriorCells(plugin).Value().SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells)];

    private static PluginFixtureData OneWorldspaceCell(string prefix, string plugin, out FormKey cellKey, out FormKey placedKey, out FormKey worldspaceKey)
    {
        FormKey cell = default, placed = default, wrld = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin(plugin, mod =>
            {
                var w = mod.Worldspaces.AddNew("OverlayWrld");
                var c = new Cell(mod) { EditorID = "OverlayCell", Grid = new CellGrid { Point = new P2Int(3, 4) } };
                var p = new PlacedObject(mod) { EditorID = "overlayRef", Position = new P3Float(7f, 8f, 9f) };
                c.Persistent.Add(p);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(c);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                w.SubCells.Add(block);
                (cell, placed, wrld) = (c.FormKey, p.FormKey, w.FormKey);
            })
            .Build();
        (cellKey, placedKey, worldspaceKey) = (cell, placed, wrld);
        return fixture;
    }

    [Fact]
    public void ABinaryPlugin_PlacesItsRefInItsCell_AndItsCellInItsWorldspace()
    {
        using var fixture = OneWorldspaceCell("placement-overlay", "OverlayWorld.esp", out var cell, out var placed, out var wrld);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("OverlayWorld.esp", PluginOrigin.DataDirectory);

        Assert.Equal("persistent", index.PlacementGroupIn(key, cell.ToString(), placed.ToString()));
        Assert.Contains(WorldspaceCells(index, key, wrld.ToString()), c => c.Cell.FormKey == cell.ToString());
    }

    [Fact]
    public void ReindexingAPlugin_ReplacesItsCellsAndPlacementsRatherThanDuplicating()
    {
        using var fixture = OneWorldspaceCell("placement-reindex", "ReindexPlacement.esp", out var cell, out var placed, out var wrld);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("ReindexPlacement.esp", PluginOrigin.DataDirectory);

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextSnapshot();

        Assert.Single(WorldspaceCells(index, key, wrld.ToString()), c => c.Cell.FormKey == cell.ToString());
        Assert.Single(index.Queries.GetCellChildRecords(key, cell.ToString()).Value().Persistent, p => p.FormKey == placed.ToString());
    }

    [Fact]
    public void ATemporaryPlacedObject_HasATemporaryPlacementRow()
    {
        using var b = new Built();
        Assert.Equal("temporary", b.Index.PlacementGroupIn(Key, b.ExtCellFk, b.RaiderFk));
    }

    [Fact]
    public void AnExteriorCell_IsListedInItsWorldspacesBlock_WithItsGrid()
    {
        using var b = new Built();

        var ext = Assert.Single(WorldspaceCells(b.Index, Key, b.WorldspaceFk), c => c.Cell.FormKey == b.ExtCellFk);

        Assert.Equal<(int?, int?, int?, int?)>((0, 0, 12, -5), (ext.BlockX, ext.BlockY, ext.Cell.CellX, ext.Cell.CellY));
        Assert.DoesNotContain(InteriorCells(b.Index, Key), c => c.FormKey == b.ExtCellFk);
    }

    [Fact]
    public void AWorldspaceTopCell_IsListedInItsWorldspace_OutsideEveryBlock()
    {
        using var b = new Built();

        var top = Assert.Single(b.Index.Queries.GetWorldspaceBlocks(Key, b.WorldspaceFk).Value().TopCells);

        Assert.Equal(b.TopCellFk, top.FormKey);
        Assert.True(top.IsPersistentWorldspaceCell);
        Assert.Null(top.CellX);
        Assert.Null(top.CellY);
        Assert.DoesNotContain(InteriorCells(b.Index, Key), c => c.FormKey == b.TopCellFk);
    }

    [Fact]
    public void AnInteriorCell_IsListedAmongTheInteriorCells_AndInNoWorldspace()
    {
        using var b = new Built();

        Assert.Contains(InteriorCells(b.Index, Key), c => c.FormKey == b.IntCellFk);
        Assert.DoesNotContain(WorldspaceCells(b.Index, Key, b.WorldspaceFk), c => c.Cell.FormKey == b.IntCellFk);
    }

    [Fact]
    public void PlacedObjects_AreAlsoIndexedAsRefrRecords()
    {
        using var b = new Built();

        Assert.All(
            [b.BarrelFk, b.NullRefFk, b.RaiderFk],
            placed => Assert.Single(b.Index.Queries.GetRecords(["refr"], Key, search: placed, limit: 10, offset: 0).Value().Items));
    }

    [Fact]
    public void ACellsChildren_SplitIntoPersistentAndTemporary()
    {
        using var b = new Built();
        var refs = b.Index.Queries.GetCellChildRecords(Key, b.ExtCellFk).Value();

        Assert.Equal(2, refs.Persistent.Count);
        Assert.Single(refs.Temporary);
        Assert.Equal("raiderRef", refs.Temporary[0].EditorId);

        var barrel = refs.Persistent.Single(p => p.FormKey == b.BarrelFk);
        Assert.Equal("barrelRef", barrel.EditorId);
        Assert.Equal("refr", barrel.RecordType);
        Assert.NotNull(barrel.BaseFormKey);

        var nullRef = refs.Persistent.Single(p => p.FormKey == b.NullRefFk);
        Assert.Null(nullRef.EditorId);
        Assert.Null(nullRef.BaseFormKey);
    }

    [Fact]
    public void AWorldspacesCells_CarryBlockGridAndNullVariants()
    {
        using var b = new Built();
        var cells = WorldspaceCells(b.Index, Key, b.WorldspaceFk);
        Assert.Equal(3, cells.Count);

        var ext = cells.Single(c => c.Cell.FormKey == b.ExtCellFk);
        Assert.Equal("ExtCell", ext.Cell.EditorId);
        Assert.Equal(0, ext.BlockX);
        Assert.Equal(0, ext.BlockY);
        Assert.Equal(0, ext.SubX);
        Assert.Equal(12, ext.Cell.CellX);
        Assert.Equal(-5, ext.Cell.CellY);

        var top = cells.Single(c => c.Cell.FormKey == b.TopCellFk);
        Assert.Null(top.BlockX);
        Assert.Null(top.Cell.CellX);
        Assert.Null(top.Cell.CellY);

        var bare = cells.Single(c => c.Cell.FormKey == b.BareCellFk);
        Assert.Null(bare.Cell.EditorId);
        Assert.Equal(1, bare.BlockX);
        Assert.Equal(1, bare.SubY);
        Assert.Null(bare.Cell.CellX);
        Assert.Null(bare.Cell.CellY);
    }

    [Fact]
    public void APlacedRef_IsListedInItsCellsPlacementGroup()
    {
        using var b = new Built();

        Assert.Equal("persistent", b.Index.PlacementGroupIn(Key, b.ExtCellFk, b.BarrelFk));
    }

    [Fact]
    public void ARecordThatIsNotPlaced_IsListedInNoCellsPlacementGroup()
    {
        using var b = new Built();

        Assert.Null(b.Index.PlacementGroupIn(Key, b.ExtCellFk, b.ExtCellFk));
        Assert.Null(b.Index.PlacementGroupIn(Key, b.ExtCellFk, "FFFFFF:TestWorld.esp"));
    }

    [Fact]
    public void CellChildRecords_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        FormKey barrel = default, placedCell = default;
        Action<Fallout4Mod> configure = mod =>
        {
            var wrld = mod.Worldspaces.AddNew("PlacedTestWorld");
            var cell = new Cell(mod) { EditorID = "PlacedCell" };
            wrld.TopCell = cell;
            var b = new PlacedObject(mod) { EditorID = "barrelRef", Position = new P3Float(1f, 2f, 3f) };
            cell.Persistent.Add(b);
            (barrel, placedCell) = (b.FormKey, cell.FormKey);
        };
        using var fixture = new PluginFixtureBuilder("placement-origins")
            .WithPlugin("Placed.esp", configure, origin: "ModA")
            .WithPlugin("Placed.esp", configure, origin: "ModB")
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        var formKey = barrel.ToString();
        var cellKey = placedCell.ToString();
        foreach (var (winner, other) in new[] { ("ModA", "ModB"), ("ModB", "ModA") })
        {
            index.WithWinner(holder, fixture.GameDirectory, fixture.Plugins, winner);
            Assert.NotNull(index.PlacementGroupIn(new PluginAddress("Placed.esp", winner), cellKey, formKey));
            Assert.Null(index.PlacementGroupIn(new PluginAddress("Placed.esp", other), cellKey, formKey));
            Assert.Null(index.PlacementGroupIn(new PluginAddress("Placed.esp", "ModC"), cellKey, formKey));
        }
    }

    private sealed class TwoOriginWorldspace : IDisposable
    {
        public TwoOriginWorldspace()
        {
            FormKey wrld = default, ext = default, placed = default, intCell = default;
            Action<Fallout4Mod> configure = mod =>
            {
                var w = mod.Worldspaces.AddNew("SharedWrld");
                var extCell = new Cell(mod) { EditorID = "SharedExtCell", Grid = new CellGrid { Point = new P2Int(1, 1) } };
                var p = new PlacedObject(mod) { EditorID = "SharedRef", Position = new P3Float(1f, 2f, 3f) };
                extCell.Persistent.Add(p);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(extCell);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                w.SubCells.Add(block);

                var interior = new Cell(mod) { EditorID = "SharedIntCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                var intSub = new CellSubBlock { BlockNumber = 0 };
                intSub.Cells.Add(interior);
                var intBlock = new CellBlock { BlockNumber = 0 };
                intBlock.SubBlocks.Add(intSub);
                mod.Cells.Records.Add(intBlock);
                (wrld, ext, placed, intCell) = (w.FormKey, extCell.FormKey, p.FormKey, interior.FormKey);
            };
            Fixture = new PluginFixtureBuilder("placement-two-origins")
                .WithPlugin("SharedWorld.esp", configure, origin: "ModA")
                .WithPlugin("SharedWorld.esp", configure, origin: "ModB")
                .BuildScattered();
            Index = Indexes.Open(_holder);
            (WorldspaceFk, ExtCellFk, PlacedFk, IntCellFk) = (wrld.ToString(), ext.ToString(), placed.ToString(), intCell.ToString());
        }

        private readonly LoadOrderHolder _holder = new();

        public ScatteredFixtureData Fixture { get; }
        public OpenedIndex Index { get; }

        public OpenedIndex WithWinner(PluginAddress winner) =>
            Index.WithWinner(_holder, Fixture.GameDirectory, Fixture.Plugins, winner.Origin);
        public string WorldspaceFk { get; }
        public string ExtCellFk { get; }
        public string PlacedFk { get; }
        public string IntCellFk { get; }

        public void Dispose()
        {
            Index.Dispose();
            Fixture.Dispose();
        }
    }

    private static readonly PluginAddress SharedA = new("SharedWorld.esp", "ModA");
    private static readonly PluginAddress SharedB = new("SharedWorld.esp", "ModB");
    private static readonly PluginAddress SharedC = new("SharedWorld.esp", "ModC");

    private static readonly (PluginAddress Winner, PluginAddress Other)[] WinnerAndOther = [(SharedA, SharedB), (SharedB, SharedA)];

    [Fact]
    public void WorldspaceCells_OfOneFilenameInTwoOrigins_AreScopedToTheOrigin()
    {
        using var f = new TwoOriginWorldspace();

        foreach (var (winner, other) in WinnerAndOther)
        {
            var index = f.WithWinner(winner);
            Assert.Single(WorldspaceCells(index, winner, f.WorldspaceFk));
            Assert.Empty(WorldspaceCells(index, other, f.WorldspaceFk));
            Assert.Empty(WorldspaceCells(index, SharedC, f.WorldspaceFk));
        }
    }

    [Fact]
    public void InteriorCells_OfOneFilenameInTwoOrigins_AreScopedToTheOrigin()
    {
        using var f = new TwoOriginWorldspace();

        foreach (var (winner, other) in WinnerAndOther)
        {
            var index = f.WithWinner(winner);
            Assert.Single(InteriorCells(index, winner));
            Assert.Empty(InteriorCells(index, other));
            Assert.Empty(InteriorCells(index, SharedC));
        }
    }

    [Fact]
    public void CellChildren_OfOneFilenameInTwoOrigins_AreScopedToTheOrigin()
    {
        using var f = new TwoOriginWorldspace();

        foreach (var (winner, other) in WinnerAndOther)
        {
            var index = f.WithWinner(winner);
            Assert.Single(index.Queries.GetCellChildRecords(winner, f.ExtCellFk).Value().Persistent);
            Assert.Empty(index.Queries.GetCellChildRecords(other, f.ExtCellFk).Value().Persistent);
            Assert.Empty(index.Queries.GetCellChildRecords(SharedC, f.ExtCellFk).Value().Persistent);
        }
    }

    [Fact]
    public void InteriorCells_CarryNullVariants()
    {
        using var b = new Built();
        var cells = InteriorCells(b.Index, Key);
        Assert.Equal(2, cells.Count);

        var named = cells.Single(c => c.FormKey == b.IntCellFk);
        Assert.Equal("IntCell", named.EditorId);
        Assert.Equal(0, named.CellX);
        Assert.Equal(0, named.CellY);

        var bare = cells.Single(c => c.FormKey == b.BareIntCellFk);
        Assert.Null(bare.EditorId);
        Assert.Null(bare.CellX);
        Assert.Null(bare.CellY);
    }
}
