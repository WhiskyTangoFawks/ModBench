using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.TestSupport;

/// <summary>A worldspace with an exterior cell and an interior cell, each holding one placed reference: the five
/// kinds of spatial record a working-tree state is read for.</summary>
public static class SpatialPlugin
{
    public const string WorldspaceEditorId = "SpatialWorld";
    public const string ExteriorCellEditorId = "SpatialExterior";
    public const string InteriorCellEditorId = "SpatialInterior";
    public const string ExteriorRefEditorId = "SpatialExteriorRef";
    public const string InteriorRefEditorId = "SpatialInteriorRef";

    public readonly record struct Records(Worldspace Worldspace, Cell ExteriorCell, Cell InteriorCell, PlacedObject ExteriorRef, PlacedObject InteriorRef);

    public static Records AddTo(Fallout4Mod mod)
    {
        var world = mod.Worldspaces.AddNew(WorldspaceEditorId);
        var exterior = new Cell(mod) { EditorID = ExteriorCellEditorId, Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var exteriorRef = new PlacedObject(mod) { EditorID = ExteriorRefEditorId };
        exterior.Persistent.Add(exteriorRef);
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        subBlock.Items.Add(exterior);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(subBlock);
        world.SubCells.Add(block);

        var interior = new Cell(mod) { EditorID = InteriorCellEditorId };
        var interiorRef = new PlacedObject(mod) { EditorID = InteriorRefEditorId };
        interior.Persistent.Add(interiorRef);
        mod.AddInteriorCells(interior);

        return new Records(world, exterior, interior, exteriorRef, interiorRef);
    }
}
