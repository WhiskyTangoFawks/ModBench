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

// The structural indexing pass must populate the `placement` and `cell_location`
// side tables that back the per-plugin worldspace tree.
//
// The fixture deliberately mixes present and absent optional values (a TopCell with no
// block/grid, a cell with no EditorID/Grid, an interior cell with no EditorID/Grid, a placed
// ref with a Base and one without) so the reader paths are exercised on both null and
// non-null columns.
public class PlacementIndexingTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private sealed record Built(
        DuckDbRecordIndex Repo,
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

        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        return new Built(repo, wrld.FormKey.ToString(), topCell.FormKey.ToString(),
            extCell.FormKey.ToString(), bareCell.FormKey.ToString(),
            intCell.FormKey.ToString(), bareIntCell.FormKey.ToString(),
            barrel.FormKey.ToString(), nullRef.FormKey.ToString(), raider.FormKey.ToString());
    }

    private static List<Dictionary<string, object?>> Query(DuckDbRecordIndex repo, string sql, string param)
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

    // Regression: production loads plugins as binary overlays, whose group wrapper
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

            using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
            repo.Initialize(GameRelease.Fallout4);
            repo.Index(overlay, Registration.Participating(0), new PluginKey(overlay.ModKey.FileName.ToString(), "Data"));
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

    // Mirrors FormReferencesTests.Index_ReIndexSamePlugin_ReplacesRatherThanDuplicates: IndexPlacement
    // must clear a plugin's prior placement/cell_location rows before rebuilding, the same way every
    // other indexed table does — otherwise a re-index (e.g. re-scanning after an external edit)
    // duplicates rows instead of replacing them.
    [Fact]
    public void Index_ReIndexSamePlugin_ReplacesPlacementAndCellLocationRatherThanDuplicating()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ReindexPlacement.esp"), Fallout4Release.Fallout4);
        var wrld = mod.Worldspaces.AddNew("ReindexWrld");
        var cell = new Cell(mod) { EditorID = "ReindexCell", Grid = new CellGrid { Point = new P2Int(1, 1) } };
        var placed = new PlacedObject(mod) { EditorID = "reindexRef", Position = new P3Float(1f, 2f, 3f) };
        cell.Persistent.Add(placed);
        var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        sub.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(sub);
        wrld.SubCells.Add(block);

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));  // re-index same plugin
        repo.UpdateWinners();

        var cellRows = Query(repo,
            "SELECT COUNT(*) AS c FROM cell_location WHERE cell_form_key = $1", cell.FormKey.ToString());
        Assert.Equal(1L, cellRows[0]["c"]);

        var placementRows = Query(repo,
            "SELECT COUNT(*) AS c FROM placement WHERE form_key = $1", placed.FormKey.ToString());
        Assert.Equal(1L, placementRows[0]["c"]);
    }

    // Index_PersistentPlacedObject persistent-row content (parent cell / group / position) is
    // covered behaviorally by GetPlacement_PlacedRef_ReturnsParentCellGroupAndPosition.

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
            "SELECT parent_worldspace, block_x, sub_x, grid_x, grid_y, is_interior FROM cell_location WHERE cell_form_key = $1",
            b.TopCellFk);
        var row = Assert.Single(rows);
        Assert.Equal(b.WorldspaceFk, row["parent_worldspace"]);
        Assert.Null(row["block_x"]);
        Assert.Null(row["sub_x"]);
        Assert.Null(row["grid_x"]);
        Assert.Null(row["grid_y"]);
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
        var result = b.Repo.Search(new RecordQuery(RecordTypes: ["refr"], Plugin: new PluginKey("TestWorld.esp"), Limit: 100, Offset: 0));
        Assert.Equal(3, result.Total);
    }

    // ── repository read methods (back the worldspace tree) ─────────────────────

    [Fact]
    public void GetCellReferences_SplitsPersistentAndTemporary()
    {
        using var b = IndexFixture();
        var refs = b.Repo.GetCellReferences(new PluginKey("TestWorld.esp", "Data"), b.ExtCellFk);

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
        var cells = b.Repo.GetWorldspaceCells(new PluginKey("TestWorld.esp", "Data"), b.WorldspaceFk);
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
        using var b = IndexFixture();
        var placement = b.Repo.GetPlacement(b.BarrelFk, new PluginKey("TestWorld.esp", "Data"));

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
        Assert.Null(b.Repo.GetPlacement(b.ExtCellFk, new PluginKey("TestWorld.esp", "Data")));
    }

    [Fact]
    public void GetPlacement_AbsentFormKey_ReturnsNull()
    {
        using var b = IndexFixture();
        Assert.Null(b.Repo.GetPlacement("FFFFFF:TestWorld.esp", new PluginKey("TestWorld.esp", "Data")));
    }

    // #272 / ADR-0036: two origins loading the same physical file — the `placement` table already
    // carries `origin` (#271) and IndexPlacement already scopes its delete by it; GetPlacement's own
    // read side was the remaining filename-only-keyed gap.
    [Fact]
    public void GetPlacement_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Placed.esp"), Fallout4Release.Fallout4);
        var wrld = mod.Worldspaces.AddNew("PlacedTestWorld");
        var cell = new Cell(mod) { EditorID = "PlacedCell" };
        wrld.TopCell = cell;
        var barrel = new PlacedObject(mod) { EditorID = "barrelRef", Position = new P3Float(1f, 2f, 3f) };
        cell.Persistent.Add(barrel);

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "ModA"));
        repo.Index((IModGetter)mod, Registration.Participating(1), new PluginKey(mod.ModKey.FileName.ToString(), "ModB"));

        var formKey = barrel.FormKey.ToString();
        Assert.NotNull(repo.GetPlacement(formKey, new PluginKey("Placed.esp", "ModA")));
        Assert.NotNull(repo.GetPlacement(formKey, new PluginKey("Placed.esp", "ModB")));
        Assert.Null(repo.GetPlacement(formKey, new PluginKey("Placed.esp", "ModC")));
    }

    // #296 / ADR-0036: same shape as GetPlacement_SameFilenameDifferentOrigin_ScopesToOrigin above —
    // one mod indexed twice under the same filename at two real (non-Data) origins. Worldspace tree
    // reads' outer WHERE filtered by plugin filename alone, so before this fix a query scoped to one
    // origin still returned both origins' rows merged together.
    private sealed record WorldspaceFixture(
        DuckDbRecordIndex Repo, string WorldspaceFk, string ExtCellFk, string PlacedFk, string IntCellFk)
        : IDisposable
    {
        public void Dispose() => Repo.Dispose();
    }

    private static WorldspaceFixture BuildTwoOriginWorldspaceFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("SharedWorld.esp"), Fallout4Release.Fallout4);
        var wrld = mod.Worldspaces.AddNew("SharedWrld");
        var extCell = new Cell(mod) { EditorID = "SharedExtCell", Grid = new CellGrid { Point = new P2Int(1, 1) } };
        var placed = new PlacedObject(mod) { EditorID = "SharedRef", Position = new P3Float(1f, 2f, 3f) };
        extCell.Persistent.Add(placed);
        var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        sub.Items.Add(extCell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(sub);
        wrld.SubCells.Add(block);

        var intCell = new Cell(mod) { EditorID = "SharedIntCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var intSub = new CellSubBlock { BlockNumber = 0 };
        intSub.Cells.Add(intCell);
        var intBlock = new CellBlock { BlockNumber = 0 };
        intBlock.SubBlocks.Add(intSub);
        mod.Cells.Records.Add(intBlock);

        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "ModA"));
        repo.Index((IModGetter)mod, Registration.Participating(1), new PluginKey(mod.ModKey.FileName.ToString(), "ModB"));
        repo.UpdateWinners();

        return new WorldspaceFixture(repo, wrld.FormKey.ToString(), extCell.FormKey.ToString(),
            placed.FormKey.ToString(), intCell.FormKey.ToString());
    }

    [Fact]
    public void GetWorldspaceCells_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        using var f = BuildTwoOriginWorldspaceFixture();

        var modACells = f.Repo.GetWorldspaceCells(new PluginKey("SharedWorld.esp", "ModA"), f.WorldspaceFk);
        var modBCells = f.Repo.GetWorldspaceCells(new PluginKey("SharedWorld.esp", "ModB"), f.WorldspaceFk);
        var modCCells = f.Repo.GetWorldspaceCells(new PluginKey("SharedWorld.esp", "ModC"), f.WorldspaceFk);

        Assert.Single(modACells);
        Assert.Single(modBCells);
        Assert.Empty(modCCells);
    }

    [Fact]
    public void GetInteriorCells_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        using var f = BuildTwoOriginWorldspaceFixture();

        var modAPage = f.Repo.GetInteriorCells(new PluginKey("SharedWorld.esp", "ModA"), 50, 0);
        var modBPage = f.Repo.GetInteriorCells(new PluginKey("SharedWorld.esp", "ModB"), 50, 0);
        var modCPage = f.Repo.GetInteriorCells(new PluginKey("SharedWorld.esp", "ModC"), 50, 0);

        Assert.Equal(1, modAPage.Total);
        Assert.Equal(1, modBPage.Total);
        Assert.Equal(0, modCPage.Total);
    }

    [Fact]
    public void GetCellReferences_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        using var f = BuildTwoOriginWorldspaceFixture();

        var modARefs = f.Repo.GetCellReferences(new PluginKey("SharedWorld.esp", "ModA"), f.ExtCellFk);
        var modBRefs = f.Repo.GetCellReferences(new PluginKey("SharedWorld.esp", "ModB"), f.ExtCellFk);
        var modCRefs = f.Repo.GetCellReferences(new PluginKey("SharedWorld.esp", "ModC"), f.ExtCellFk);

        Assert.Single(modARefs.Persistent);
        Assert.Single(modBRefs.Persistent);
        Assert.Empty(modCRefs.Persistent);
    }

    [Fact]
    public void GetInteriorCells_ReturnsInteriorCellsWithNullVariants()
    {
        using var b = IndexFixture();
        var page = b.Repo.GetInteriorCells(new PluginKey("TestWorld.esp", "Data"), 50, 0);
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

    // #458: same non-unique-ordering shape as Search's — several interior cells below share
    // "DupCell", two more share a blank EditorID (ordinary in real plugin data), so an
    // ORDER BY c.editor_id with no tiebreak leaves DuckDB free to place tied rows on either side of
    // a LIMIT/OFFSET boundary differently across calls. Paging the full set two cells at a time and
    // concatenating the pages must reconstruct exactly the single unpaged read's order — no cell
    // skipped, none repeated — and doing the same walk again must reproduce the identical sequence.
    private static DuckDbRecordIndex BuildDuplicateEditorIdInteriorCellsFixture(out int total)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("DupCells.esp"), Fallout4Release.Fallout4);
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

        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();
        total = intSub.Cells.Count;
        return repo;
    }

    [Fact]
    public void GetInteriorCells_PagesCellsWithSharedAndBlankEditorId_ReturnsEveryRowExactlyOnceAndStably()
    {
        using var repo = BuildDuplicateEditorIdInteriorCellsFixture(out var total);
        var plugin = new PluginKey("DupCells.esp", "Data");

        var full = repo.GetInteriorCells(plugin, 100, 0);
        Assert.Equal(total, full.Total);
        var expected = full.Items.Select(i => i.FormKey).ToList();

        List<string> WalkAllPages()
        {
            var seen = new List<string>();
            for (var offset = 0; offset < full.Total; offset += 2)
            {
                var page = repo.GetInteriorCells(plugin, 2, offset);
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
