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
    private static readonly PluginAddress Key = new("TestWorld.esp", "Data");

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
        public IRecordReads Reads => Index.RequireReads();
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
    public void ABinaryPlugin_HasPlacementAndCellLocation()
    {
        using var fixture = OneWorldspaceCell("placement-overlay", "OverlayWorld.esp", out var cell, out var placed, out var wrld);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("OverlayWorld.esp", "Data");
        var reads = index.RequireReads();

        Assert.Equal("persistent", reads.PlacementGroupIn(key, cell.ToString(), placed.ToString()));

        var location = reads.GetCellLocation(key, cell.ToString());
        Assert.NotNull(location);
        Assert.Equal(wrld.ToString(), location.Value.ParentWorldspace);
    }

    [Fact]
    public void ReindexingAPlugin_ReplacesPlacementAndCellLocationRatherThanDuplicating()
    {
        using var fixture = OneWorldspaceCell("placement-reindex", "ReindexPlacement.esp", out var cell, out var placed, out var wrld);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("ReindexPlacement.esp", "Data");

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextSnapshot();

        var reads = index.RequireReads();
        Assert.Single(reads.GetWorldspaceCells(key, wrld.ToString()), c => c.FormKey == cell.ToString());
        Assert.Single(reads.GetCellChildRecords(key, cell.ToString()).Persistent, p => p.FormKey == placed.ToString());
        Assert.NotNull(reads.PlacementGroupIn(key, cell.ToString(), placed.ToString()));
    }

    [Fact]
    public void ATemporaryPlacedObject_HasATemporaryPlacementRow()
    {
        using var b = new Built();
        Assert.Equal("temporary", b.Reads.PlacementGroupIn(Key, b.ExtCellFk, b.RaiderFk));
    }

    [Fact]
    public void AnExteriorCell_HasCellLocationWithWorldspaceBlockAndGrid()
    {
        using var b = new Built();
        var location = b.Reads.GetCellLocation(Key, b.ExtCellFk);
        Assert.NotNull(location);
        Assert.Equal(b.WorldspaceFk, location.Value.ParentWorldspace);
        Assert.Equal(0, location.Value.BlockX);
        Assert.Equal(0, location.Value.BlockY);
        Assert.Equal(12, location.Value.GridX);
        Assert.Equal(-5, location.Value.GridY);
        Assert.False(location.Value.IsInterior);
    }

    [Fact]
    public void AWorldspaceTopCell_HasCellLocationWithWorldspaceButNoBlock()
    {
        using var b = new Built();
        var location = b.Reads.GetCellLocation(Key, b.TopCellFk);
        Assert.NotNull(location);
        Assert.Equal(b.WorldspaceFk, location.Value.ParentWorldspace);
        Assert.Null(location.Value.BlockX);
        Assert.Null(location.Value.SubX);
        Assert.Null(location.Value.GridX);
        Assert.Null(location.Value.GridY);
        Assert.False(location.Value.IsInterior);
    }

    [Fact]
    public void AnInteriorCell_HasCellLocationWithNullWorldspaceAndInteriorFlag()
    {
        using var b = new Built();
        var location = b.Reads.GetCellLocation(Key, b.IntCellFk);
        Assert.NotNull(location);
        Assert.Null(location.Value.ParentWorldspace);
        Assert.True(location.Value.IsInterior);
    }

    [Fact]
    public void PlacedObjects_AreAlsoIndexedAsRefrRecords()
    {
        using var b = new Built();
        var result = b.Reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["refr"], Plugin: Key.Name, Limit: 100, Offset: 0));
        Assert.Equal(3, result.Total);
    }

    [Fact]
    public void ACellsChildren_SplitIntoPersistentAndTemporary()
    {
        using var b = new Built();
        var refs = b.Reads.GetCellChildRecords(Key, b.ExtCellFk);

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
        var cells = b.Reads.GetWorldspaceCells(Key, b.WorldspaceFk);
        Assert.Equal(3, cells.Count);

        var ext = cells.Single(c => c.FormKey == b.ExtCellFk);
        Assert.Equal("ExtCell", ext.EditorId);
        Assert.Equal(0, ext.BlockX);
        Assert.Equal(0, ext.BlockY);
        Assert.Equal(0, ext.SubX);
        Assert.Equal(12, ext.CellX);
        Assert.Equal(-5, ext.CellY);

        var top = cells.Single(c => c.FormKey == b.TopCellFk);
        Assert.Null(top.BlockX);
        Assert.Null(top.CellX);
        Assert.Null(top.CellY);

        var bare = cells.Single(c => c.FormKey == b.BareCellFk);
        Assert.Null(bare.EditorId);
        Assert.Equal(1, bare.BlockX);
        Assert.Equal(1, bare.SubY);
        Assert.Null(bare.CellX);
        Assert.Null(bare.CellY);
    }

    [Fact]
    public void APlacedRef_IsListedInItsCellsPlacementGroup()
    {
        using var b = new Built();

        Assert.Equal("persistent", b.Reads.PlacementGroupIn(Key, b.ExtCellFk, b.BarrelFk));
    }

    [Fact]
    public void ARecordThatIsNotPlaced_IsListedInNoCellsPlacementGroup()
    {
        using var b = new Built();

        Assert.Null(b.Reads.PlacementGroupIn(Key, b.ExtCellFk, b.ExtCellFk));
        Assert.Null(b.Reads.PlacementGroupIn(Key, b.ExtCellFk, "FFFFFF:TestWorld.esp"));
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
            var reads = index.ReadsWithWinner(holder, fixture.GameDirectory, fixture.Plugins, winner);
            Assert.NotNull(reads.PlacementGroupIn(new PluginAddress("Placed.esp", winner), cellKey, formKey));
            Assert.Null(reads.PlacementGroupIn(new PluginAddress("Placed.esp", other), cellKey, formKey));
            Assert.Null(reads.PlacementGroupIn(new PluginAddress("Placed.esp", "ModC"), cellKey, formKey));
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

        public IRecordReads ReadsWithWinner(PluginAddress winner) =>
            Index.ReadsWithWinner(_holder, Fixture.GameDirectory, Fixture.Plugins, winner.Origin);
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
            var reads = f.ReadsWithWinner(winner);
            Assert.Single(reads.GetWorldspaceCells(winner, f.WorldspaceFk));
            Assert.Empty(reads.GetWorldspaceCells(other, f.WorldspaceFk));
            Assert.Empty(reads.GetWorldspaceCells(SharedC, f.WorldspaceFk));
        }
    }

    [Fact]
    public void InteriorCells_OfOneFilenameInTwoOrigins_AreScopedToTheOrigin()
    {
        using var f = new TwoOriginWorldspace();

        foreach (var (winner, other) in WinnerAndOther)
        {
            var reads = f.ReadsWithWinner(winner);
            Assert.Single(reads.GetInteriorCells(winner));
            Assert.Empty(reads.GetInteriorCells(other));
            Assert.Empty(reads.GetInteriorCells(SharedC));
        }
    }

    [Fact]
    public void CellChildren_OfOneFilenameInTwoOrigins_AreScopedToTheOrigin()
    {
        using var f = new TwoOriginWorldspace();

        foreach (var (winner, other) in WinnerAndOther)
        {
            var reads = f.ReadsWithWinner(winner);
            Assert.Single(reads.GetCellChildRecords(winner, f.ExtCellFk).Persistent);
            Assert.Empty(reads.GetCellChildRecords(other, f.ExtCellFk).Persistent);
            Assert.Empty(reads.GetCellChildRecords(SharedC, f.ExtCellFk).Persistent);
        }
    }

    [Fact]
    public void InteriorCells_CarryNullVariants()
    {
        using var b = new Built();
        var cells = b.Reads.GetInteriorCells(Key);
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
