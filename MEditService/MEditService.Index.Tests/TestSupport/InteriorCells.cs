using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.TestSupport;

internal static class InteriorCells
{
    /// <summary>The cells under one interior block and sub-block, numbered zero.</summary>
    internal static void AddInteriorCells(this Fallout4Mod mod, params Cell[] cells)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.AddRange(cells);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }
}
