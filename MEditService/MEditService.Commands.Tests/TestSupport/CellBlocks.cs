using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The block and sub-block GRUPs a cell sits in.</summary>
internal static class CellBlocks
{
    /// <summary>An exterior cell's, by its grid: a sub-block spans 8 cells a side, a block 4 sub-blocks.</summary>
    internal static WorldspaceBlock Exterior(Cell cell)
    {
        var (x, y) = (cell.Grid?.Point.X ?? 0, cell.Grid?.Point.Y ?? 0);
        var (subX, subY) = (FloorDiv(x, 8), FloorDiv(y, 8));
        var subBlock = new WorldspaceSubBlock { BlockNumberX = (short)subX, BlockNumberY = (short)subY };
        subBlock.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = (short)FloorDiv(subX, 4), BlockNumberY = (short)FloorDiv(subY, 4) };
        block.Items.Add(subBlock);
        return block;
    }

    internal static CellBlock Interior(Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        return block;
    }

    private static int FloorDiv(int value, int by) => (int)Math.Floor(value / (double)by);
}
