using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Core.Queries;

public interface IWorldspaceQueryService
{
    // ADR-0036: origin — stated by a caller that knows which copy of `plugin` it's
    // browsing (a tree row does; it was built from one), else resolved from the load order.
    IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin, string? origin = null);
    WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey, string? origin = null);
    CellReferences GetCellReferences(string plugin, string cellFormKey, string? origin = null);
    PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string? origin = null);
}

/// <summary>Everything a plugin declares (own records and overrides), never a cross-plugin winner.
/// See ADR-0023.</summary>
public sealed class WorldspaceQueryService(IQueryIndex index, ILogger<WorldspaceQueryService>? logger = null)
    : IWorldspaceQueryService
{
    private const int WorldspaceListLimit = 5000;

    private readonly IQueryIndex _index = index;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin, string? origin = null)
    {
        var (loadOrder, repo) = _index.RequireScope();
        origin ??= ResolveOrigin(loadOrder, plugin);
        // Without an origin filter, two same-filename plugins' worldspace lists silently merge
        // into one under this plugin name.
        var query = new RecordQuery(RecordTypes: ["wrld"], Plugin: new PluginKey(plugin, origin), Limit: WorldspaceListLimit, Offset: 0);
        // Search answers "on it or below it" through the container relation, which a worldspace's
        // cells are not part of, so the cell side is a second read rather than a walk from here.
        var failedBelow = repo.GetWorldspacesWithFailuresBelow(new PluginKey(plugin, origin));
        return [.. repo.Search(query)
            .Items.Select(r => new WorldspaceSummary(
                r.FormKey, r.EditorId, r.HasParseFailure || failedBelow.Contains(r.FormKey)))];
    }

    public WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey, string? origin = null)
    {
        var (loadOrder, reads) = _index.RequireScope();
        origin ??= ResolveOrigin(loadOrder, plugin);
        var cells = reads.GetWorldspaceCells(new PluginKey(plugin, origin), worldspaceFormKey);

        // A TopCell has no block coordinates. Every block-less row is surfaced, but the data can't
        // say which of several is the real TopCell, so the first (deterministic order) is treated
        // as persistent and the rest are anomalous.
        var topCellRows = cells.Where(c => c.BlockX == null).ToList();
        if (topCellRows.Count > 1)
        {
            _logger.LogWarning(
                "Worldspace {WorldspaceFormKey} in {Plugin} ({Origin}) has {Count} block-less cell rows; " +
                "expected at most one TopCell. Surfacing all, but only the first is treated as the persistent cell.",
                worldspaceFormKey, plugin, origin, topCellRows.Count);
        }
        var topCells = topCellRows
            .Select((c, i) => new CellSummary(
                c.FormKey, c.EditorId, c.CellX, c.CellY, IsPersistentWorldspaceCell: i == 0,
                FullName: c.FullName, HasParseFailure: c.HasParseFailure))
            .ToList();

        // A block and a sub-block are grouping nodes with no record of their own, so their failure
        // fact is exactly their cells' — folded here, from the rows this response already holds.
        var blocks = cells
            .Where(c => c.BlockX != null)
            .GroupBy(c => (X: c.BlockX!.Value, Y: c.BlockY ?? 0))
            .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
            .Select(blockGroup =>
            {
                var subBlocks = blockGroup
                    .GroupBy(c => (X: c.SubX ?? 0, Y: c.SubY ?? 0))
                    .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
                    .Select(subGroup => new WorldspaceSubBlockDto(
                        subGroup.Key.X, subGroup.Key.Y,
                        [.. subGroup.Select(c => new CellSummary(
                            c.FormKey, c.EditorId, c.CellX, c.CellY,
                            FullName: c.FullName, HasParseFailure: c.HasParseFailure))],
                        subGroup.Any(c => c.HasParseFailure)))
                    .ToList();
                return new WorldspaceBlockDto(
                    blockGroup.Key.X, blockGroup.Key.Y, subBlocks, subBlocks.Exists(b => b.HasParseFailure));
            })
            .ToList();

        return new WorldspaceBlocks(blocks, topCells);
    }

    public CellReferences GetCellReferences(string plugin, string cellFormKey, string? origin = null)
    {
        var (loadOrder, reads) = _index.RequireScope();
        origin ??= ResolveOrigin(loadOrder, plugin);
        return reads.GetCellReferences(new PluginKey(plugin, origin), cellFormKey);
    }

    public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string? origin = null)
    {
        var (loadOrder, reads) = _index.RequireScope();
        return reads.GetInteriorCells(new PluginKey(plugin, origin ?? ResolveOrigin(loadOrder, plugin)), limit, offset);
    }

    // An ordinary load-order row has no origin to give, so this stays the fallback; callers that
    // do know (a tree row built from a specific copy) pass an explicit origin instead.
    private static string ResolveOrigin(ILoadOrder loadOrder, string plugin) =>
        PluginOriginResolver.Resolve(loadOrder, plugin);
}
