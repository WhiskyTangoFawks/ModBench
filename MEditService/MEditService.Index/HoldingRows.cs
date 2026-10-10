using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

namespace MEditService.Index;

/// <summary>One record <paramref name="Parent"/> holds in <paramref name="Slot"/>. SlotIndex is the
/// real GRUP position. Effective only: every write path re-derives it.</summary>
internal readonly record struct HoldingRow(string Parent, string Child, string Slot, int SlotIndex);
// Rejected: having every reader existence-check against records instead, which would make "these
// tables track Effective" a documented falsehood.

internal readonly record struct CellLocationRow(
    string CellFormKey,
    int? BlockX, int? BlockY, int? SubX, int? SubY, int? GridX, int? GridY, bool IsInterior);

/// <summary>The slots that tell what a holding is. An exterior cell sits in a block directory of its
/// own, so no worldspace document carries it.</summary>
internal static class HoldingSlots
{
    internal const string ExteriorCell = "SubCells";

    internal static readonly string Placed = $"'{PersistentFlag.PersistentGroup}', '{PersistentFlag.TemporaryGroup}'";

    internal static readonly string TopCell = $"'{PlacedCell.WorldspacePersistentCellMember}'";
}

/// <summary>A cell's grid out of its own text, the block coordinates out of the structure handed
/// over beside it.</summary>
internal static class CellLocations
{
    /// <summary>A null document is a cell whose text the codec could not produce: its place in the
    /// world is still known, its grid is not.</summary>
    internal static CellLocationRow Of(string cellFormKey, Document? cellDocument, CellStructure structure)
    {
        var grid = cellDocument?.Grid;

        return new CellLocationRow(
            cellFormKey, structure.BlockX, structure.BlockY, structure.SubX, structure.SubY,
            grid?.X, grid?.Y, structure.IsInterior);
    }
}
