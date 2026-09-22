using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.TestSupport;

/// <summary>The nested shape every container fixture needs: a flat cell, an embedded cell with
/// placed refs, a navmesh and a landscape, and a worldspace with its own top cell.</summary>
public static class ContainerModPlugin
{
    public const string CellEditorId = "FixtureCell";
    public const string EmbedCellEditorId = "EmbedCell";
    public const string TemporaryRefEditorId = "TempRef";
    public const string PersistentRefEditorId = "PersistRef";
    public const string NavmeshEditorId = "EmbedNavmesh";
    public const string LandscapeEditorId = "EmbedLandscape";
    public const string WorldspaceEditorId = "EmbedWorld";
    public const string TopCellEditorId = "EmbedTopCell";
    public const string TopCellRefEditorId = "TopCellRef";

    public readonly record struct Keys(
        FormKey Cell, FormKey EmbedCell, FormKey TemporaryRef, FormKey PersistentRef,
        FormKey Navmesh, FormKey Landscape, FormKey Worldspace, FormKey TopCell, FormKey TopCellRef);

    public static Keys AddTo(Fallout4Mod mod)
    {
        var cell = new Cell(mod) { EditorID = CellEditorId, WaterHeight = 100f };
        AddInteriorCell(mod, cell, blockNumber: 0);

        var embedCell = new Cell(mod) { EditorID = EmbedCellEditorId, WaterHeight = 10f };
        var temporaryRef = new PlacedObject(mod)
        {
            EditorID = TemporaryRefEditorId,
            Position = new P3Float(11f, 22f, 33f),
            Scale = 1f,
        };
        var persistentRef = new PlacedObject(mod)
        {
            EditorID = PersistentRefEditorId,
            Position = new P3Float(1f, 2f, 3f),
            Scale = 4f,
        };
        var navmesh = new NavigationMesh(mod) { EditorID = NavmeshEditorId };
        var landscape = new Landscape(mod) { EditorID = LandscapeEditorId };
        embedCell.Temporary.Add(temporaryRef);
        embedCell.Persistent.Add(persistentRef);
        embedCell.NavigationMeshes.Add(navmesh);
        embedCell.Landscape = landscape;
        AddInteriorCell(mod, embedCell, blockNumber: 1);

        var worldspace = new Worldspace(mod) { EditorID = WorldspaceEditorId };
        var topCell = new Cell(mod) { EditorID = TopCellEditorId, WaterHeight = 5f };
        var topCellRef = new PlacedObject(mod)
        {
            EditorID = TopCellRefEditorId,
            Position = new P3Float(7f, 8f, 9f),
            Scale = 6f,
        };
        topCell.Temporary.Add(topCellRef);
        worldspace.TopCell = topCell;
        mod.Worldspaces.Add(worldspace);

        return new Keys(
            cell.FormKey, embedCell.FormKey, temporaryRef.FormKey, persistentRef.FormKey,
            navmesh.FormKey, landscape.FormKey, worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);
    }

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell, int blockNumber)
    {
        var subBlock = new CellSubBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = blockNumber, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }
}
