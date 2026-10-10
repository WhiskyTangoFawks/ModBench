using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.Index.Queries;

public interface IWorldspaceQueryService
{
    Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin);
    Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey);
    Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey);
    Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin);
}

/// <summary>Everything a plugin declares (own records and overrides), never a cross-plugin
/// winner.</summary>
internal sealed class WorldspaceQueryService(IQueryIndex index, LoadOrderHolder loadOrder) : IWorldspaceQueryService
{
    private const int WorldspaceListLimit = 5000;

    private readonly IQueryIndex _index = index;
    private readonly LoadOrderHolder _loadOrder = loadOrder;

    public Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin) =>
        IndexAnswer.Of(() => WorldspacesOf(plugin));

    private IReadOnlyList<WorldspaceSummary> WorldspacesOf(PluginAddress plugin)
    {
        var repo = _index.RequireReads();
        // Without an origin filter, two same-filename plugins' worldspace lists silently merge
        // into one under this plugin name.
        var query = new RecordQuery(RecordQueryScope.Navigator, RecordTypes: [RecordTypes.For(_loadOrder.Require().GameRelease).Worldspace], Plugin: plugin.Name, Origin: plugin.Origin, Limit: WorldspaceListLimit, Offset: 0, GroupOnly: true);
        var holdingCells = repo.GetWorldspacesHoldingCells(plugin);
        return [.. repo.Search(query)
            .Items.Select(r => new WorldspaceSummary(
                r.FormKey, r.EditorId, r.WorkingTreeState, r.HasParseFailure, r.FullName, r.ParseDiagnosis,
                holdingCells.Contains(r.FormKey)))];
    }

    public Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey) =>
        IndexAnswer.Of(() => BlocksOf(plugin, worldspaceFormKey));

    private WorldspaceBlocks BlocksOf(PluginAddress plugin, string worldspaceFormKey)
    {
        var cells = _index.RequireReads().GetWorldspaceCells(plugin, worldspaceFormKey);

        // A TopCell has no block coordinates.
        var topCells = cells
            .Where(c => c.BlockX == null)
            .Select(c => CellOf(c) with { IsPersistentWorldspaceCell = true })
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

    public Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey) =>
        IndexAnswer.Of(() => _index.RequireReads().GetCellChildRecords(plugin, cellFormKey));

    public Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin) =>
        IndexAnswer.Of(() => InteriorCellsOf(plugin));

    private IReadOnlyList<InteriorCellBlock> InteriorCellsOf(PluginAddress plugin)
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
        new(c.FormKey, c.EditorId, c.CellX, c.CellY, c.WorkingTreeState,
            FullName: c.FullName, HasParseFailure: c.HasParseFailure, ParseDiagnosis: c.ParseDiagnosis,
            HasChildren: c.HasChildren);
}
