using MEditService.Index;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;

namespace MEditService.Queries;

public interface IWorldspaceQueryService
{
    IReadOnlyList<WorldspaceSummary> GetWorldspaces(PluginAddress plugin);
    WorldspaceBlocks GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey);
    CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey);
    IReadOnlyList<InteriorCellBlock> GetInteriorCells(PluginAddress plugin);
}

/// <summary>Everything a plugin declares (own records and overrides), never a cross-plugin
/// winner.</summary>
internal sealed class WorldspaceQueryService(IQueryIndex index, ILogger<WorldspaceQueryService> logger)
    : IWorldspaceQueryService
{
    private const int WorldspaceListLimit = 5000;

    private readonly IQueryIndex _index = index;
    private readonly ILogger _logger = logger;

    public IReadOnlyList<WorldspaceSummary> GetWorldspaces(PluginAddress plugin)
    {
        var repo = _index.RequireReads();
        // Without an origin filter, two same-filename plugins' worldspace lists silently merge
        // into one under this plugin name.
        var query = new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["wrld"], Plugin: plugin.Name, Origin: plugin.Origin, Limit: WorldspaceListLimit, Offset: 0, GroupOnly: true);
        var holdingCells = repo.GetWorldspacesHoldingCells(plugin);
        return [.. repo.Search(query)
            .Items.Select(r => new WorldspaceSummary(
                r.FormKey, r.EditorId, r.HasParseFailure, r.FullName, r.ParseDiagnosis,
                holdingCells.Contains(r.FormKey), r.WorkingTreeState.ToQuery()))];
    }

    public WorldspaceBlocks GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey)
    {
        var cells = _index.RequireReads().GetWorldspaceCells(plugin, worldspaceFormKey);

        // A TopCell has no block coordinates. Every block-less row is surfaced, but the data can't
        // say which of several is the real TopCell, so the first (deterministic order) is treated
        // as persistent and the rest are anomalous.
        var topCellRows = cells.Where(c => c.BlockX == null).ToList();
        if (topCellRows.Count > 1)
        {
            _logger.LogWarning(
                "Worldspace {WorldspaceFormKey} in {Plugin} ({Origin}) has {Count} block-less cell rows; " +
                "expected at most one TopCell. Surfacing all, but only the first is treated as the persistent cell.",
                worldspaceFormKey, plugin.Name, plugin.Origin, topCellRows.Count);
        }
        var topCells = topCellRows
            .Select((c, i) => CellOf(c) with { IsPersistentWorldspaceCell = i == 0 })
            .ToList();

        // A block and a sub-block are grouping nodes with no record of their own, so their failure
        // fact is exactly their cells' — folded here, from the rows this response already holds.
        var blocks = cells
            .Where(c => c.BlockX != null)
            .GroupBy(c => (
                X: c.BlockX ?? throw new InvalidOperationException("Expected a block cell to carry its X coordinate."),
                Y: c.BlockY ?? 0))
            .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
            .Select(blockGroup =>
            {
                var subBlocks = blockGroup
                    .GroupBy(c => (X: c.SubX ?? 0, Y: c.SubY ?? 0))
                    .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
                    .Select(subGroup => new WorldspaceSubBlockDto(
                        subGroup.Key.X, subGroup.Key.Y,
                        [.. subGroup.Select(CellOf)],
                        subGroup.Any(c => c.HasParseFailure)))
                    .ToList();
                return new WorldspaceBlockDto(
                    blockGroup.Key.X, blockGroup.Key.Y, subBlocks, subBlocks.Exists(b => b.HasParseFailure));
            })
            .ToList();

        return new WorldspaceBlocks(blocks, topCells);
    }

    public CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey) =>
        _index.RequireReads().GetCellChildRecords(plugin, cellFormKey).ToQuery();

    public IReadOnlyList<InteriorCellBlock> GetInteriorCells(PluginAddress plugin)
    {
        return [.. _index.RequireReads().GetInteriorCells(plugin)
            .GroupBy(c => c.BlockX ?? 0)
            .Select(block =>
            {
                var subBlocks = block
                    .GroupBy(c => c.SubX ?? 0)
                    .Select(subBlock => new InteriorCellSubBlock(
                        subBlock.Key, [.. subBlock.Select(CellOf)], subBlock.Any(c => c.HasParseFailure)))
                    .ToList();
                return new InteriorCellBlock(block.Key, subBlocks, subBlocks.Exists(s => s.HasParseFailure));
            })];
    }

    private static CellSummary CellOf(CellLocationSummary c) =>
        new(c.FormKey, c.EditorId, c.CellX, c.CellY,
            FullName: c.FullName, HasParseFailure: c.HasParseFailure, ParseDiagnosis: c.ParseDiagnosis,
            HasChildren: c.HasChildren, WorkingTreeState: c.WorkingTreeState.ToQuery());
}
