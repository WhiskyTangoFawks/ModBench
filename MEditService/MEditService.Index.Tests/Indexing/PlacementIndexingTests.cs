using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Index.Tests.Indexing;

// The fixture deliberately mixes present and absent optional values, so the reader paths are
// exercised on both null and non-null columns.
public class PlacementIndexingTests
{
    private static readonly PluginCopyKey Key = new("TestWorld.esp", "Data");

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

                    // Worldspace TopCell — no block/sub coordinates, no grid (null columns).
                    var topCell = new Cell(mod) { EditorID = "TopCell" };
                    w.TopCell = topCell;

                    // Fully-populated exterior cell with a persistent + temporary ref.
                    var extCell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(12, -5) } };
                    var barrelRef = new PlacedObject(mod)
                    {
                        EditorID = "barrelRef",
                        Position = new P3Float(10f, 20f, 30f),
                        Base = new FormLinkNullable<IPlaceableObjectGetter>(FormKey.Factory("000ABC:TestWorld.esp")),
                    };
                    var bareRef = new PlacedObject(mod);   // no EditorID, no Base — null label columns
                    var raiderRef = new PlacedObject(mod) { EditorID = "raiderRef" };
                    extCell.Persistent.Add(barrelRef);
                    extCell.Persistent.Add(bareRef);
                    extCell.Temporary.Add(raiderRef);

                    // Exterior cell with no EditorID and no grid — null editor_id / grid columns.
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
                    var bareInterior = new Cell(mod);   // no EditorID, no grid
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
        public IndexProjector Index { get; }
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
    public void Index_FromBinary_PopulatesPlacementAndCellLocation()
    {
        using var fixture = OneWorldspaceCell("placement-overlay", "OverlayWorld.esp", out var cell, out var placed, out var wrld);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginCopyKey("OverlayWorld.esp", "Data");
        var reads = index.RequireReads();

        var placement = reads.GetPlacement(placed.ToString(), key);
        Assert.NotNull(placement);
        Assert.Equal(cell.ToString(), placement.Value.ParentCell);
        Assert.Equal("persistent", placement.Value.PlacementGroup);
        Assert.Equal(7f, placement.Value.PosX);

        var location = reads.GetCellLocation(key, cell.ToString());
        Assert.NotNull(location);
        Assert.Equal(wrld.ToString(), location.Value.ParentWorldspace);
    }

    // A re-index must replace a plugin's prior placement and cell-location rows the way every other
    // indexed table does; otherwise re-scanning after an external edit duplicates rather than replaces.
    [Fact]
    public async Task Index_ReIndexSamePlugin_ReplacesPlacementAndCellLocationRatherThanDuplicating()
    {
        using var fixture = OneWorldspaceCell("placement-reindex", "ReindexPlacement.esp", out var cell, out var placed, out var wrld);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginCopyKey("ReindexPlacement.esp", "Data");

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        Assert.True(await index.RefreshBinary(key, fixture.Plugins.Single().Path));

        var reads = index.RequireReads();
        Assert.Single(reads.GetWorldspaceCells(key, wrld.ToString()), c => c.FormKey == cell.ToString());
        Assert.Single(reads.GetCellReferences(key, cell.ToString()).Persistent, p => p.FormKey == placed.ToString());
        Assert.NotNull(reads.GetPlacement(placed.ToString(), key));
    }

    [Fact]
    public void Index_TemporaryPlacedObject_WritesTemporaryPlacementRow()
    {
        using var b = new Built();
        var placement = b.Reads.GetPlacement(b.RaiderFk, Key);
        Assert.NotNull(placement);
        Assert.Equal(b.ExtCellFk, placement.Value.ParentCell);
        Assert.Equal("temporary", placement.Value.PlacementGroup);
    }

    [Fact]
    public void Index_ExteriorCell_WritesCellLocationWithWorldspaceBlockAndGrid()
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
    public void Index_WorldspaceTopCell_WritesCellLocationWithWorldspaceButNoBlock()
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
    public void Index_InteriorCell_WritesCellLocationWithNullWorldspaceAndInteriorFlag()
    {
        using var b = new Built();
        var location = b.Reads.GetCellLocation(Key, b.IntCellFk);
        Assert.NotNull(location);
        Assert.Null(location.Value.ParentWorldspace);
        Assert.True(location.Value.IsInterior);
    }

    [Fact]
    public void Index_PlacedObjects_AreAlsoIndexedAsRefrRecords()
    {
        using var b = new Built();
        // refr is a normal record table; the placed objects appear there too.
        var result = b.Reads.Search(new RecordQuery(RecordTypes: ["refr"], Plugin: Key.Name, Limit: 100, Offset: 0));
        Assert.Equal(3, result.Total);
    }

    // ── reads that back the worldspace tree ─────────────────────

    [Fact]
    public void GetCellReferences_SplitsPersistentAndTemporary()
    {
        using var b = new Built();
        var refs = b.Reads.GetCellReferences(Key, b.ExtCellFk);

        Assert.Equal(2, refs.Persistent.Count);
        Assert.Single(refs.Temporary);
        Assert.Equal("raiderRef", refs.Temporary[0].EditorId);

        var barrel = refs.Persistent.Single(p => p.FormKey == b.BarrelFk);
        Assert.Equal("barrelRef", barrel.EditorId);
        Assert.Equal("refr", barrel.RecordType);
        Assert.NotNull(barrel.BaseFormKey);            // Base present → base column non-null

        var nullRef = refs.Persistent.Single(p => p.FormKey == b.NullRefFk);
        Assert.Null(nullRef.EditorId);                 // no EditorID → editor_id column null
        Assert.Null(nullRef.BaseFormKey);
    }

    [Fact]
    public void GetWorldspaceCells_ReturnsCellsWithBlockGridAndNullVariants()
    {
        using var b = new Built();
        var cells = b.Reads.GetWorldspaceCells(Key, b.WorldspaceFk);
        Assert.Equal(3, cells.Count);  // TopCell + ExtCell + BareCell

        var ext = cells.Single(c => c.FormKey == b.ExtCellFk);
        Assert.Equal("ExtCell", ext.EditorId);
        Assert.Equal(0, ext.BlockX);
        Assert.Equal(0, ext.BlockY);
        Assert.Equal(0, ext.SubX);
        Assert.Equal(12, ext.CellX);
        Assert.Equal(-5, ext.CellY);

        var top = cells.Single(c => c.FormKey == b.TopCellFk);
        Assert.Null(top.BlockX);   // TopCell has no block coordinates
        Assert.Null(top.CellX);    // and no grid
        Assert.Null(top.CellY);

        var bare = cells.Single(c => c.FormKey == b.BareCellFk);
        Assert.Null(bare.EditorId);  // no EditorID
        Assert.Equal(1, bare.BlockX);
        Assert.Equal(1, bare.SubY);
        Assert.Null(bare.CellX);     // no grid
        Assert.Null(bare.CellY);
    }

    // ── GetPlacement (placed-path lookup) ───────────

    [Fact]
    public void GetPlacement_PlacedRef_ReturnsParentCellGroupAndPosition()
    {
        using var b = new Built();
        var placement = b.Reads.GetPlacement(b.BarrelFk, Key);

        Assert.NotNull(placement);
        Assert.Equal(b.ExtCellFk, placement.Value.ParentCell);
        Assert.Equal("persistent", placement.Value.PlacementGroup);
        Assert.Equal(10f, placement.Value.PosX);
        Assert.Equal(20f, placement.Value.PosY);
        Assert.Equal(30f, placement.Value.PosZ);
    }

    [Fact]
    public void GetPlacement_NonPlacedRecord_ReturnsNull()
    {
        using var b = new Built();
        Assert.Null(b.Reads.GetPlacement(b.ExtCellFk, Key));
    }

    [Fact]
    public void GetPlacement_AbsentFormKey_ReturnsNull()
    {
        using var b = new Built();
        Assert.Null(b.Reads.GetPlacement("FFFFFF:TestWorld.esp", Key));
    }

    // ADR-0012: two origins holding the same filename — the placement read scopes by origin, not
    // by filename alone.
    [Fact]
    public void GetPlacement_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        FormKey barrel = default;
        Action<Fallout4Mod> configure = mod =>
        {
            var wrld = mod.Worldspaces.AddNew("PlacedTestWorld");
            var cell = new Cell(mod) { EditorID = "PlacedCell" };
            wrld.TopCell = cell;
            var b = new PlacedObject(mod) { EditorID = "barrelRef", Position = new P3Float(1f, 2f, 3f) };
            cell.Persistent.Add(b);
            barrel = b.FormKey;
        };
        using var fixture = new PluginFixtureBuilder("placement-origins")
            .WithPlugin("Placed.esp", configure, origin: "ModA")
            .WithPlugin("Placed.esp", configure, origin: "ModB")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        var formKey = barrel.ToString();
        Assert.NotNull(reads.GetPlacement(formKey, new PluginCopyKey("Placed.esp", "ModA")));
        Assert.NotNull(reads.GetPlacement(formKey, new PluginCopyKey("Placed.esp", "ModB")));
        Assert.Null(reads.GetPlacement(formKey, new PluginCopyKey("Placed.esp", "ModC")));
    }

    // ADR-0012: one plugin held twice under the same filename at two real origins. A worldspace tree
    // read filtering by plugin filename alone answers an origin-scoped query with both origins merged.
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
            Index = Indexes.Reconciled(Fixture);
            (WorldspaceFk, ExtCellFk, PlacedFk, IntCellFk) = (wrld.ToString(), ext.ToString(), placed.ToString(), intCell.ToString());
        }

        public ScatteredFixtureData Fixture { get; }
        public IndexProjector Index { get; }
        public IRecordReads Reads => Index.RequireReads();
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

    private static readonly PluginCopyKey SharedA = new("SharedWorld.esp", "ModA");
    private static readonly PluginCopyKey SharedB = new("SharedWorld.esp", "ModB");
    private static readonly PluginCopyKey SharedC = new("SharedWorld.esp", "ModC");

    [Fact]
    public void GetWorldspaceCells_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        using var f = new TwoOriginWorldspace();

        Assert.Single(f.Reads.GetWorldspaceCells(SharedA, f.WorldspaceFk));
        Assert.Single(f.Reads.GetWorldspaceCells(SharedB, f.WorldspaceFk));
        Assert.Empty(f.Reads.GetWorldspaceCells(SharedC, f.WorldspaceFk));
    }

    [Fact]
    public void GetInteriorCells_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        using var f = new TwoOriginWorldspace();

        Assert.Equal(1, f.Reads.GetInteriorCells(SharedA, 50, 0).Total);
        Assert.Equal(1, f.Reads.GetInteriorCells(SharedB, 50, 0).Total);
        Assert.Equal(0, f.Reads.GetInteriorCells(SharedC, 50, 0).Total);
    }

    [Fact]
    public void GetCellReferences_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        using var f = new TwoOriginWorldspace();

        Assert.Single(f.Reads.GetCellReferences(SharedA, f.ExtCellFk).Persistent);
        Assert.Single(f.Reads.GetCellReferences(SharedB, f.ExtCellFk).Persistent);
        Assert.Empty(f.Reads.GetCellReferences(SharedC, f.ExtCellFk).Persistent);
    }

    [Fact]
    public void GetInteriorCells_ReturnsInteriorCellsWithNullVariants()
    {
        using var b = new Built();
        var page = b.Reads.GetInteriorCells(Key, 50, 0);
        Assert.Equal(2, page.Total);

        var named = page.Items.Single(c => c.FormKey == b.IntCellFk);
        Assert.Equal("IntCell", named.EditorId);
        Assert.Equal(0, named.CellX);
        Assert.Equal(0, named.CellY);

        var bare = page.Items.Single(c => c.FormKey == b.BareIntCellFk);
        Assert.Null(bare.EditorId);
        Assert.Null(bare.CellX);
        Assert.Null(bare.CellY);
    }

    // Several cells share "DupCell" and two more share a blank EditorID, ordinary in real plugin
    // data, so an ORDER BY with no tiebreak lets DuckDB place tied rows either side of a LIMIT
    // boundary.
    [Fact]
    public void GetInteriorCells_PagesCellsWithSharedAndBlankEditorId_ReturnsEveryRowExactlyOnceAndStably()
    {
        var total = 0;
        using var fixture = new PluginFixtureBuilder("placement-dup-cells")
            .WithPlugin("DupCells.esp", mod =>
            {
                var intSub = new CellSubBlock { BlockNumber = 0 };
                for (var i = 0; i < 3; i++)
                    intSub.Cells.Add(new Cell(mod) { EditorID = "DupCell" });
                for (var i = 0; i < 2; i++)
                    intSub.Cells.Add(new Cell(mod)); // blank EditorID
                intSub.Cells.Add(new Cell(mod) { EditorID = "UniqueCellA" });
                intSub.Cells.Add(new Cell(mod) { EditorID = "UniqueCellB" });
                var intBlock = new CellBlock { BlockNumber = 0 };
                intBlock.SubBlocks.Add(intSub);
                mod.Cells.Records.Add(intBlock);
                total = intSub.Cells.Count;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();
        var plugin = new PluginCopyKey("DupCells.esp", "Data");

        var full = reads.GetInteriorCells(plugin, 100, 0);
        Assert.Equal(total, full.Total);
        var expected = full.Items.Select(i => i.FormKey).ToList();

        List<string> WalkAllPages()
        {
            var seen = new List<string>();
            for (var offset = 0; offset < full.Total; offset += 2)
            {
                var page = reads.GetInteriorCells(plugin, 2, offset);
                seen.AddRange(page.Items.Select(i => i.FormKey));
            }
            return seen;
        }

        var firstWalk = WalkAllPages();
        var secondWalk = WalkAllPages();

        Assert.Equal(expected, firstWalk);
        Assert.Equal(firstWalk, secondWalk);
    }
}
