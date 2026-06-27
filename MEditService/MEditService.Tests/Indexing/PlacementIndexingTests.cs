using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Indexing;

// Phase 16: the structural indexing pass must populate the `placement` and `cell_location`
// side tables that back the per-plugin worldspace tree.
//
// The fixture deliberately mixes present and absent optional values (a TopCell with no
// block/grid, a cell with no EditorID/Grid, an interior cell with no EditorID/Grid, a placed
// ref with a Base and one without) so the reader paths are exercised on both null and
// non-null columns.
public class PlacementIndexingTests
{
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly ITableDdlBuilder _ddl = new TableDdlBuilder(_reflector);

    private sealed record Built(
        DuckDbRecordRepository Repo,
        string WorldspaceFk,
        string TopCellFk,
        string ExtCellFk,
        string BareCellFk,
        string IntCellFk,
        string BareIntCellFk,
        string BarrelFk,
        string NullRefFk,
        string RaiderFk) : IDisposable
    {
        public void Dispose() => Repo.Dispose();
    }

    private static float ToF(object? v) => Convert.ToSingle(v, CultureInfo.InvariantCulture);
    private static int ToI(object? v) => Convert.ToInt32(v, CultureInfo.InvariantCulture);
    private static bool ToB(object? v) => Convert.ToBoolean(v, CultureInfo.InvariantCulture);

    private static Built IndexFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("TestWorld.esp"), Fallout4Release.Fallout4);

        var wrld = mod.Worldspaces.AddNew("CommonwealthTest");

        // Worldspace TopCell — no block/sub coordinates, no grid (null columns).
        var topCell = new Cell(mod) { EditorID = "TopCell" };
        wrld.TopCell = topCell;

        // Fully-populated exterior cell with a persistent + temporary ref.
        var extCell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(12, -5) } };
        var barrel = new PlacedObject(mod)
        {
            EditorID = "barrelRef",
            Position = new P3Float(10f, 20f, 30f),
            Base = new FormLinkNullable<IPlaceableObjectGetter>(FormKey.Factory("000ABC:TestWorld.esp")),
        };
        var nullRef = new PlacedObject(mod);   // no EditorID, no Base — null label columns
        var raider = new PlacedObject(mod) { EditorID = "raiderRef" };
        extCell.Persistent.Add(barrel);
        extCell.Persistent.Add(nullRef);
        extCell.Temporary.Add(raider);

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

        wrld.SubCells.Add(block);
        wrld.SubCells.Add(block2);

        var intCell = new Cell(mod) { EditorID = "IntCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var bareIntCell = new Cell(mod);   // no EditorID, no grid
        var intSub = new CellSubBlock { BlockNumber = 0 };
        intSub.Cells.Add(intCell);
        intSub.Cells.Add(bareIntCell);
        var intBlock = new CellBlock { BlockNumber = 0 };
        intBlock.SubBlocks.Add(intSub);
        mod.Cells.Records.Add(intBlock);

        var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, 0);
        repo.UpdateWinners();

        return new Built(repo, wrld.FormKey.ToString(), topCell.FormKey.ToString(),
            extCell.FormKey.ToString(), bareCell.FormKey.ToString(),
            intCell.FormKey.ToString(), bareIntCell.FormKey.ToString(),
            barrel.FormKey.ToString(), nullRef.FormKey.ToString(), raider.FormKey.ToString());
    }

    private static List<Dictionary<string, object?>> Query(DuckDbRecordRepository repo, string sql, string param)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.Add(new DuckDBParameter { Value = param });
        using var reader = cmd.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>();
            for (int i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    // Regression (Phase 16.2.2): production loads plugins as binary overlays, whose group wrapper
    // exposes records by being IEnumerable rather than via a "Records" member (the in-memory shape).
    // PlacementWalker must index placement off the overlay too — IndexFixture above only covers the
    // in-memory mod, so this round-trips through disk to exercise the overlay path.
    [Fact]
    public void Index_FromBinaryOverlay_PopulatesPlacementAndCellLocation()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("OverlayWorld.esp"), Fallout4Release.Fallout4);
        var wrld = mod.Worldspaces.AddNew("OverlayWrld");
        var cell = new Cell(mod) { EditorID = "OverlayCell", Grid = new CellGrid { Point = new P2Int(3, 4) } };
        var placed = new PlacedObject(mod) { EditorID = "overlayRef", Position = new P3Float(7f, 8f, 9f) };
        cell.Persistent.Add(placed);
        var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        sub.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(sub);
        wrld.SubCells.Add(block);

        var dir = Directory.CreateTempSubdirectory("medit-overlay");
        try
        {
            var path = Path.Combine(dir.FullName, "OverlayWorld.esp");
            mod.WriteToBinary(path, new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
            {
                MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
            });

            using var overlay = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(
                new ModPath(mod.ModKey, path), GameRelease.Fallout4);

            using var repo = new DuckDbRecordRepository(_reflector, _ddl, NullLogger.Instance);
            repo.Initialize(GameRelease.Fallout4);
            repo.Index(overlay, 0);
            repo.UpdateWinners();

            var rows = Query(repo,
                "SELECT parent_cell, placement_group, pos_x FROM placement WHERE form_key = $1",
                placed.FormKey.ToString());
            var row = Assert.Single(rows);
            Assert.Equal(cell.FormKey.ToString(), row["parent_cell"]);
            Assert.Equal("persistent", row["placement_group"]);
            Assert.Equal(7f, ToF(row["pos_x"]));

            var cellRows = Query(repo,
                "SELECT parent_worldspace FROM cell_location WHERE cell_form_key = $1", cell.FormKey.ToString());
            Assert.Equal(wrld.FormKey.ToString(), Assert.Single(cellRows)["parent_worldspace"]);
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Index_PersistentPlacedObject_WritesPlacementRow()
    {
        using var b = IndexFixture();
        var rows = Query(b.Repo,
            "SELECT parent_cell, placement_group, pos_x, pos_y, pos_z FROM placement WHERE form_key = $1", b.BarrelFk);
        var row = Assert.Single(rows);
        Assert.Equal(b.ExtCellFk, row["parent_cell"]);
        Assert.Equal("persistent", row["placement_group"]);
        Assert.Equal(10f, ToF(row["pos_x"]));
        Assert.Equal(20f, ToF(row["pos_y"]));
        Assert.Equal(30f, ToF(row["pos_z"]));
    }

    [Fact]
    public void Index_TemporaryPlacedObject_WritesTemporaryPlacementRow()
    {
        using var b = IndexFixture();
        var rows = Query(b.Repo,
            "SELECT parent_cell, placement_group FROM placement WHERE form_key = $1", b.RaiderFk);
        var row = Assert.Single(rows);
        Assert.Equal(b.ExtCellFk, row["parent_cell"]);
        Assert.Equal("temporary", row["placement_group"]);
    }

    [Fact]
    public void Index_ExteriorCell_WritesCellLocationWithWorldspaceBlockAndGrid()
    {
        using var b = IndexFixture();
        var rows = Query(b.Repo,
            "SELECT parent_worldspace, block_x, block_y, sub_x, sub_y, grid_x, grid_y, is_interior FROM cell_location WHERE cell_form_key = $1",
            b.ExtCellFk);
        var row = Assert.Single(rows);
        Assert.Equal(b.WorldspaceFk, row["parent_worldspace"]);
        Assert.Equal(0, ToI(row["block_x"]));
        Assert.Equal(0, ToI(row["block_y"]));
        Assert.Equal(12, ToI(row["grid_x"]));
        Assert.Equal(-5, ToI(row["grid_y"]));
        Assert.False(ToB(row["is_interior"]));
    }

    [Fact]
    public void Index_WorldspaceTopCell_WritesCellLocationWithWorldspaceButNoBlock()
    {
        using var b = IndexFixture();
        var rows = Query(b.Repo,
            "SELECT parent_worldspace, block_x, sub_x, grid_x, is_interior FROM cell_location WHERE cell_form_key = $1",
            b.TopCellFk);
        var row = Assert.Single(rows);
        Assert.Equal(b.WorldspaceFk, row["parent_worldspace"]);
        Assert.Null(row["block_x"]);
        Assert.Null(row["sub_x"]);
        Assert.Null(row["grid_x"]);
        Assert.False(ToB(row["is_interior"]));
    }

    [Fact]
    public void Index_InteriorCell_WritesCellLocationWithNullWorldspaceAndInteriorFlag()
    {
        using var b = IndexFixture();
        var rows = Query(b.Repo,
            "SELECT parent_worldspace, is_interior FROM cell_location WHERE cell_form_key = $1", b.IntCellFk);
        var row = Assert.Single(rows);
        Assert.Null(row["parent_worldspace"]);
        Assert.True(ToB(row["is_interior"]));
    }

    [Fact]
    public void Index_PlacedObjects_AreAlsoIndexedAsRefrRecords()
    {
        using var b = IndexFixture();
        // refr is now a normal record table; the placed objects appear there too.
        var result = b.Repo.GetRecords("refr", "TestWorld.esp", null, 100, 0);
        Assert.Equal(3, result.Total);
    }

    // ── repository read methods (back the worldspace tree) ─────────────────────

    [Fact]
    public void GetCellReferences_SplitsPersistentAndTemporary()
    {
        using var b = IndexFixture();
        var refs = b.Repo.GetCellReferences("TestWorld.esp", b.ExtCellFk);

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
        using var b = IndexFixture();
        var cells = b.Repo.GetWorldspaceCells("TestWorld.esp", b.WorldspaceFk);
        Assert.Equal(3, cells.Count);  // TopCell + ExtCell + BareCell

        var ext = cells.Single(c => c.FormKey == b.ExtCellFk);
        Assert.Equal("ExtCell", ext.EditorId);
        Assert.Equal(0, ext.BlockX);
        Assert.Equal(0, ext.BlockY);
        Assert.Equal(12, ext.CellX);
        Assert.Equal(-5, ext.CellY);

        var top = cells.Single(c => c.FormKey == b.TopCellFk);
        Assert.Null(top.BlockX);   // TopCell has no block coordinates
        Assert.Null(top.CellX);    // and no grid

        var bare = cells.Single(c => c.FormKey == b.BareCellFk);
        Assert.Null(bare.EditorId);  // no EditorID
        Assert.Equal(1, bare.BlockX);
        Assert.Equal(1, bare.SubY);
        Assert.Null(bare.CellX);     // no grid
    }

    // ── GetPlacement (Phase 16.2.2: orchestrator placed-path lookup) ───────────

    [Fact]
    public void GetPlacement_PlacedRef_ReturnsParentCellGroupAndPosition()
    {
        using var b = IndexFixture();
        var placement = b.Repo.GetPlacement(b.BarrelFk, "TestWorld.esp");

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
        using var b = IndexFixture();
        Assert.Null(b.Repo.GetPlacement(b.ExtCellFk, "TestWorld.esp"));
    }

    [Fact]
    public void GetPlacement_AbsentFormKey_ReturnsNull()
    {
        using var b = IndexFixture();
        Assert.Null(b.Repo.GetPlacement("FFFFFF:TestWorld.esp", "TestWorld.esp"));
    }

    [Fact]
    public void GetInteriorCells_ReturnsInteriorCellsWithNullVariants()
    {
        using var b = IndexFixture();
        var page = b.Repo.GetInteriorCells("TestWorld.esp", 50, 0);
        Assert.Equal(2, page.Total);

        var named = page.Items.Single(c => c.FormKey == b.IntCellFk);
        Assert.Equal("IntCell", named.EditorId);
        Assert.Equal(0, named.CellX);

        var bare = page.Items.Single(c => c.FormKey == b.BareIntCellFk);
        Assert.Null(bare.EditorId);
        Assert.Null(bare.CellX);
    }
}
