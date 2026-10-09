using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

namespace MEditService.Index;

internal readonly record struct PlacementRow(
    string FormKey, string ParentCell, string PlacementGroup);

internal readonly record struct CellLocationRow(
    string CellFormKey, string? ParentWorldspace,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? GridX, int? GridY, bool IsInterior);

/// <summary>The table a child record's parentage lands in.</summary>
internal enum ParentageTable { ContainerChild, Placement, CellLocation }

/// <summary>The worldspace-tree side tables read off documents: a cell's grid out of its own
/// text, the block coordinates out of the structure handed over beside it.</summary>
internal static class PlacementWalker
{
    internal static ParentageTable TableFor(RecordTypes types, string recordType, string slotName) => slotName switch
    {
        PersistentFlag.PersistentGroup or PersistentFlag.TemporaryGroup when types.IsCell(recordType) => ParentageTable.Placement,
        PlacedCell.WorldspacePersistentCellMember when types.IsWorldspace(recordType) => ParentageTable.CellLocation,
        _ => ParentageTable.ContainerChild,
    };

    /// <summary>The <c>placement_group</c> a placement slot's children land in.</summary>
    internal static string PlacementGroupOf(string slotName) => slotName.ToLowerInvariant();

    /// <summary>A null document is a cell whose text the codec could not produce: its place in the
    /// world is still known, its grid is not.</summary>
    internal static CellLocationRow CellLocation(
        string cellFormKey, Document? cellDocument, CellStructure structure)
    {
        var grid = cellDocument?.Grid;

        return new CellLocationRow(
            cellFormKey, structure.ParentWorldspace,
            structure.BlockX, structure.BlockY, structure.SubX, structure.SubY,
            grid?.X, grid?.Y, structure.IsInterior);
    }
}
