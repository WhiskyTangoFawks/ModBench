using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>A placed reference's row in the <c>placement</c> side table.</summary>
public readonly record struct PlacementRow(
    string FormKey, string ParentCell, string PlacementGroup, float? PosX, float? PosY, float? PosZ);

/// <summary>A cell's row in the <c>cell_location</c> side table.</summary>
public readonly record struct CellLocationRow(
    string CellFormKey, string? ParentWorldspace,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? GridX, int? GridY, bool IsInterior);

/// <summary>Walks the worldspace/cell GRUP hierarchy and yields the structural parentage
/// <c>EnumerateMajorRecords</c> flattens away. Reflects on Mutagen's property names, which are the
/// same across every game, rather than a game-specific interface.</summary>
public sealed class PlacementWalker
{
    private readonly ConcurrentDictionary<(Type, string), MemberInfo?> _members = new();

    // Block/sub-block coordinates of an exterior cell; default (all null) for top and interior cells.
    private readonly record struct BlockCoords(int? BlockX, int? BlockY, int? SubX, int? SubY);

    public void Walk(IModGetter mod, Action<CellLocationRow> onCell, Action<PlacementRow> onPlacement)
    {
        foreach (var wrld in Enumerate(Get(mod, "Worldspaces")))
            WalkWorldspace(wrld, onCell, onPlacement);

        // Interior cells: mod.Cells (ListGroup) -> CellBlock.SubBlocks -> CellSubBlock.Cells
        foreach (var cellBlock in Enumerate(Get(mod, "Cells")))
        {
            foreach (var subBlock in List(cellBlock, "SubBlocks"))
            {
                foreach (var cell in List(subBlock, "Cells"))
                    EmitCell(cell, null, default, isInterior: true, onCell, onPlacement);
            }
        }
    }

    private void WalkWorldspace(object wrld, Action<CellLocationRow> onCell, Action<PlacementRow> onPlacement)
    {
        var wrldFk = ((IMajorRecordGetter)wrld).FormKey.ToString();

        if (Get(wrld, "TopCell") is { } topCell)
            EmitCell(topCell, wrldFk, default, isInterior: false, onCell, onPlacement);

        foreach (var block in List(wrld, "SubCells"))
            WalkExteriorBlock(block, wrldFk, onCell, onPlacement);
    }

    private void WalkExteriorBlock(object block, string wrldFk, Action<CellLocationRow> onCell, Action<PlacementRow> onPlacement)
    {
        int? bx = Int(Get(block, "BlockNumberX"));
        int? by = Int(Get(block, "BlockNumberY"));
        foreach (var sub in List(block, "Items"))
        {
            int? sx = Int(Get(sub, "BlockNumberX"));
            int? sy = Int(Get(sub, "BlockNumberY"));
            foreach (var cell in List(sub, "Items"))
                EmitCell(cell, wrldFk, new BlockCoords(bx, by, sx, sy), isInterior: false, onCell, onPlacement);
        }
    }

    private void EmitCell(
        object cell, string? worldspaceFk, BlockCoords coords, bool isInterior,
        Action<CellLocationRow> onCell, Action<PlacementRow> onPlacement)
    {
        var cellRec = (IMajorRecordGetter)cell;
        onCell(EmitCellLocationRow(
            cellRec, worldspaceFk, coords.BlockX, coords.BlockY, coords.SubX, coords.SubY, isInterior));

        EmitPlaced(cell, cellRec.FormKey.ToString(), "Persistent", "persistent", onPlacement);
        EmitPlaced(cell, cellRec.FormKey.ToString(), "Temporary", "temporary", onPlacement);
    }

    private void EmitPlaced(object cell, string cellFk, string listName, string group, Action<PlacementRow> onPlacement)
    {
        foreach (var placed in List(cell, listName))
        {
            if (placed is not IMajorRecordGetter rec) continue;
            onPlacement(EmitPlacementRow(rec, cellFk, group));
        }
    }

    /// <summary>The single-cell half of <see cref="EmitCell"/>, for the working-tree re-derivation of
    /// one already-in-hand cell. The block/sub/worldspace facts a lone document cannot carry are
    /// supplied by the caller.</summary>
    internal CellLocationRow EmitCellLocationRow(
        IMajorRecordGetter cell, string? parentWorldspace, int? blockX, int? blockY, int? subX, int? subY,
        bool isInterior)
    {
        var cellFk = cell.FormKey.ToString();
        var point = Get(Get(cell, "Grid"), "Point");
        int? gx = point == null ? null : Int(Get(point, "X"));
        int? gy = point == null ? null : Int(Get(point, "Y"));

        return new CellLocationRow(cellFk, parentWorldspace, blockX, blockY, subX, subY, gx, gy, isInterior);
    }

    /// <summary>The single-item half of <see cref="EmitPlaced"/>, for the same reason as the cell
    /// variant.</summary>
    internal PlacementRow EmitPlacementRow(IMajorRecordGetter placed, string parentCellFormKey, string group)
    {
        var pos = Get(placed, "Position");
        float? px = null, py = null, pz = null;
        if (pos != null)
        {
            px = Float(Get(pos, "X"));
            py = Float(Get(pos, "Y"));
            pz = Float(Get(pos, "Z"));
        }
        return new PlacementRow(placed.FormKey.ToString(), parentCellFormKey, group, px, py, pz);
    }

    // ── reflection helpers (property-or-field, cached) ──────────────────────────

    private MemberInfo? Member(Type type, string name) =>
        _members.GetOrAdd((type, name), k =>
            (MemberInfo?)k.Item1.GetProperty(k.Item2, BindingFlags.Public | BindingFlags.Instance)
            ?? k.Item1.GetField(k.Item2, BindingFlags.Public | BindingFlags.Instance));

    private object? Get(object? obj, string name)
    {
        return obj == null
            ? null
            : Member(obj.GetType(), name) switch
            {
                PropertyInfo p => p.GetValue(obj),
                FieldInfo f => f.GetValue(obj),
                _ => null,
            };
    }

    private IEnumerable<object> List(object? obj, string name) =>
        Get(obj, name) is IEnumerable e ? e.Cast<object>() : [];

    // Top-level groups differ by getter shape: the in-memory group has a "Records" member, the
    // binary-overlay wrapper is itself IEnumerable<T>. Both are enumerable, so iterate the group
    // itself rather than reflecting on a member name.
    private static IEnumerable<object> Enumerate(object? group) =>
        group is IEnumerable e ? e.Cast<object>() : [];

    // Only called with values that are structurally present (block/sub-block numbers are
    // non-nullable; grid/position are read after a not-null guard), so no null branch is needed.
    private static int Int(object? v) => Convert.ToInt32(v, CultureInfo.InvariantCulture);
    private static float Float(object? v) => Convert.ToSingle(v, CultureInfo.InvariantCulture);
}
