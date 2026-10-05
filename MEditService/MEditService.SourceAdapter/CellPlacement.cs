namespace MEditService.SourceAdapter;

/// <summary>Where the tree puts a cell: the worldspace whose subtree carries it and the block
/// directories it sits in. An interior cell has neither; a worldspace's own top cell has a
/// worldspace and no block.</summary>
internal readonly record struct CellPlacement(
    string? ParentWorldspace, int? BlockX, int? BlockY, int? SubX, int? SubY, bool IsInterior)
{
    // Every game's GRUP layout: a sub-block spans 8 cells a side, and a block 4 sub-blocks.
    private const int CellsPerSubBlock = 8;
    private const int SubBlocksPerBlock = 4;

    /// <summary>Where the exterior cell at grid (<paramref name="x"/>, <paramref name="y"/>) of
    /// <paramref name="worldspace"/> sits.</summary>
    internal static CellPlacement AtGrid(string worldspace, int x, int y)
    {
        var (subX, subY) = (FloorDiv(x, CellsPerSubBlock), FloorDiv(y, CellsPerSubBlock));
        return new(worldspace, FloorDiv(subX, SubBlocksPerBlock), FloorDiv(subY, SubBlocksPerBlock), subX, subY, IsInterior: false);
    }

    private static int FloorDiv(int value, int by) => (int)Math.Floor(value / (double)by);
}
