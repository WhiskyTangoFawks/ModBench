using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Core.Queries;

public interface IWorldspaceQueryService
{
    // #305 / ADR-0036: origin — stated by a caller that knows which copy of `plugin` it's
    // browsing (a tree row does; it was built from one), else resolved from the load order as
    // before. Mirrors GetRecords/GetPluginRecordTypes (#34).
    IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin, string? origin = null);
    WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey, string? origin = null);
    CellReferences GetCellReferences(string plugin, string cellFormKey, string? origin = null);
    PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string? origin = null);
}

/// <summary>
/// Per-plugin worldspace / cell / placed-object tree. Reads the indexed worldspace records and the
/// placement / cell_location side tables — everything that plugin declares (its own records and
/// overrides), never a cross-plugin winner. See ADR-0023.
/// </summary>
public sealed class WorldspaceQueryService(ILoadOrderMirror loadOrder, ILogger<WorldspaceQueryService>? logger = null)
    : IWorldspaceQueryService
{
    private const int WorldspaceListLimit = 5000;

    private readonly ILoadOrderMirror _mirror = loadOrder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin, string? origin = null)
    {
        origin ??= ResolveOrigin(plugin);
        var repo = RequireReads();
        // #296: same class of bug as the other worldspace-tree reads — without an origin filter, two
        // same-filename plugins' worldspace lists silently merged into one under this plugin name.
        var query = new RecordQuery(RecordTypes: ["wrld"], Plugin: new PluginKey(plugin, origin), Limit: WorldspaceListLimit, Offset: 0);
        return [.. repo.Search(query)
            .Items.Select(r => new WorldspaceSummary(r.FormKey, r.EditorId))];
    }

    public WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey, string? origin = null)
    {
        origin ??= ResolveOrigin(plugin);
        var cells = RequireReads().GetWorldspaceCells(new PluginKey(plugin, origin), worldspaceFormKey);

        // A worldspace's TopCell (persistent interior cell) has no block/sub-block coordinates.
        // #251: normally there is exactly one such row — the worldspace's own TopCell slot — but
        // every block-less row is surfaced rather than keeping only the first and discarding the
        // rest. The data can't say which of several is the "real" TopCell, so the first (existing
        // deterministic order) is the one treated as the persistent cell; anything past it is
        // still shown, just not labeled as persistent, and is genuinely anomalous — worth a warning.
        var topCellRows = cells.Where(c => c.BlockX == null).ToList();
        if (topCellRows.Count > 1)
        {
            _logger.LogWarning(
                "Worldspace {WorldspaceFormKey} in {Plugin} ({Origin}) has {Count} block-less cell rows; " +
                "expected at most one TopCell. Surfacing all, but only the first is treated as the persistent cell.",
                worldspaceFormKey, plugin, origin, topCellRows.Count);
        }
        var topCells = topCellRows
            .Select((c, i) => new CellSummary(c.FormKey, c.EditorId, c.CellX, c.CellY, IsPersistentWorldspaceCell: i == 0, FullName: c.FullName))
            .ToList();

        var blocks = cells
            .Where(c => c.BlockX != null)
            .GroupBy(c => (X: c.BlockX!.Value, Y: c.BlockY ?? 0))
            .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
            .Select(blockGroup => new WorldspaceBlockDto(
                blockGroup.Key.X, blockGroup.Key.Y,
                [.. blockGroup
                    .GroupBy(c => (X: c.SubX ?? 0, Y: c.SubY ?? 0))
                    .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
                    .Select(subGroup => new WorldspaceSubBlockDto(
                        subGroup.Key.X, subGroup.Key.Y,
                        [.. subGroup.Select(c => new CellSummary(c.FormKey, c.EditorId, c.CellX, c.CellY, FullName: c.FullName))]))]))
            .ToList();

        return new WorldspaceBlocks(blocks, topCells);
    }

    public CellReferences GetCellReferences(string plugin, string cellFormKey, string? origin = null)
    {
        origin ??= ResolveOrigin(plugin);
        return RequireReads().GetCellReferences(new PluginKey(plugin, origin), cellFormKey);
    }

    public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string? origin = null) =>
        RequireReads().GetInteriorCells(new PluginKey(plugin, origin ?? ResolveOrigin(plugin)), limit, offset);

    private IRecordReads RequireReads() => _mirror.RequireScope().Reads;

    // #296 / #305: wire-facing (WorldspaceEndpoints) — an ordinary load-order row has no origin to
    // give, so this stays the fallback. #34/#305 gave the callers that *do* know (a tree row built
    // from a specific copy) an explicit origin parameter on every method above instead.
    private string ResolveOrigin(string plugin) =>
        PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);
}
