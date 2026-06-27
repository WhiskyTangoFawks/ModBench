using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// A placed reference's row in the <c>placement</c> side table.
/// </summary>
public readonly record struct PlacementRow(
    string FormKey, string ParentCell, string PlacementGroup, float? PosX, float? PosY, float? PosZ);

/// <summary>
/// A cell's row in the <c>cell_location</c> side table.
/// </summary>
public readonly record struct CellLocationRow(
    string CellFormKey, string? ParentWorldspace,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? GridX, int? GridY, bool IsInterior);

/// <summary>
/// Walks the worldspace/cell GRUP hierarchy of a mod and yields the structural parentage that
/// <see cref="EnumerateMajorRecords"/> flattens away (which cell a placed ref is in, persistent vs
/// temporary, which worldspace a cell is in, block/sub-block, grid).
///
/// Game-agnostic by design: Mutagen generates the same property names across every game
/// (<c>Worldspaces</c>, <c>SubCells</c>, <c>Persistent</c>, <c>Grid</c>, ...), so this reflects on
/// those names rather than depending on a game-specific interface — consistent with the
/// reflection-driven <c>SchemaReflector</c> and the "support all games without code changes" invariant.
/// </summary>
public sealed class PlacementWalker
{
    private readonly ConcurrentDictionary<(Type, string), MemberInfo?> _members = new();

    public void Walk(IModGetter mod, Action<CellLocationRow> onCell, Action<PlacementRow> onPlacement)
    {
        foreach (var wrld in Enumerate(Get(mod, "Worldspaces")))
        {
            var wrldFk = ((IMajorRecordGetter)wrld).FormKey.ToString();

            if (Get(wrld, "TopCell") is { } topCell)
                EmitCell(topCell, wrldFk, null, null, null, null, isInterior: false, onCell, onPlacement);

            foreach (var block in List(wrld, "SubCells"))
            {
                int? bx = Int(Get(block, "BlockNumberX"));
                int? by = Int(Get(block, "BlockNumberY"));
                foreach (var sub in List(block, "Items"))
                {
                    int? sx = Int(Get(sub, "BlockNumberX"));
                    int? sy = Int(Get(sub, "BlockNumberY"));
                    foreach (var cell in List(sub, "Items"))
                        EmitCell(cell, wrldFk, bx, by, sx, sy, isInterior: false, onCell, onPlacement);
                }
            }
        }

        // Interior cells: mod.Cells (ListGroup) -> CellBlock.SubBlocks -> CellSubBlock.Cells
        foreach (var cellBlock in Enumerate(Get(mod, "Cells")))
            foreach (var subBlock in List(cellBlock, "SubBlocks"))
                foreach (var cell in List(subBlock, "Cells"))
                    EmitCell(cell, null, null, null, null, null, isInterior: true, onCell, onPlacement);
    }

    private void EmitCell(
        object cell, string? worldspaceFk, int? bx, int? by, int? sx, int? sy, bool isInterior,
        Action<CellLocationRow> onCell, Action<PlacementRow> onPlacement)
    {
        var cellFk = ((IMajorRecordGetter)cell).FormKey.ToString();
        var point = Get(Get(cell, "Grid"), "Point");
        int? gx = point == null ? null : Int(Get(point, "X"));
        int? gy = point == null ? null : Int(Get(point, "Y"));

        onCell(new CellLocationRow(cellFk, worldspaceFk, bx, by, sx, sy, gx, gy, isInterior));

        EmitPlaced(cell, cellFk, "Persistent", "persistent", onPlacement);
        EmitPlaced(cell, cellFk, "Temporary", "temporary", onPlacement);
    }

    private void EmitPlaced(object cell, string cellFk, string listName, string group, Action<PlacementRow> onPlacement)
    {
        foreach (var placed in List(cell, listName))
        {
            if (placed is not IMajorRecordGetter rec) continue;
            var pos = Get(placed, "Position");
            float? px = null, py = null, pz = null;
            if (pos != null)
            {
                px = Float(Get(pos, "X"));
                py = Float(Get(pos, "Y"));
                pz = Float(Get(pos, "Z"));
            }
            onPlacement(new PlacementRow(rec.FormKey.ToString(), cellFk, group, px, py, pz));
        }
    }

    // ── reflection helpers (property-or-field, cached) ──────────────────────────

    private MemberInfo? Member(Type type, string name) =>
        _members.GetOrAdd((type, name), k =>
            (MemberInfo?)k.Item1.GetProperty(k.Item2, BindingFlags.Public | BindingFlags.Instance)
            ?? k.Item1.GetField(k.Item2, BindingFlags.Public | BindingFlags.Instance));

    private object? Get(object? obj, string name)
    {
        if (obj == null) return null;
        return Member(obj.GetType(), name) switch
        {
            PropertyInfo p => p.GetValue(obj),
            FieldInfo f => f.GetValue(obj),
            _ => null,
        };
    }

    private IEnumerable<object> List(object? obj, string name) =>
        Get(obj, name) is IEnumerable e ? e.Cast<object>() : [];

    // Top-level groups expose their records differently across getter shapes: the in-memory
    // Fallout4Group<T> surfaces a "Records" member, while the binary-overlay group wrapper has no
    // such member but is itself IEnumerable<T>. Both are directly enumerable, so iterate the group
    // object itself rather than reflecting on a member name (which only existed on the in-memory shape).
    private static IEnumerable<object> Enumerate(object? group) =>
        group is IEnumerable e ? e.Cast<object>() : [];

    // Callers only invoke these with values that are structurally present (block/sub-block
    // numbers are non-nullable; grid/position are read only after a not-null guard), so no
    // null branch is needed here — absence is handled at the call site.
    private static int Int(object? v) => Convert.ToInt32(v, CultureInfo.InvariantCulture);
    private static float Float(object? v) => Convert.ToSingle(v, CultureInfo.InvariantCulture);
}
