using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Session;

namespace MEditService.Core.Queries;

public interface IWorldspaceQueryService
{
    IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin);
    WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey);
    CellReferences GetCellReferences(string plugin, string cellFormKey);
    PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset);
}

/// <summary>
/// Per-plugin worldspace / cell / placed-object tree. Reads the indexed worldspace records and the
/// placement / cell_location side tables — everything that plugin declares (its own records and
/// overrides), never a cross-plugin winner. See ADR-0023.
/// </summary>
public sealed class WorldspaceQueryService : IWorldspaceQueryService
{
    private const int WorldspaceListLimit = 5000;

    private readonly ISessionManager _session;
    private readonly IPendingChangeService _changes;

    public WorldspaceQueryService(ISessionManager session, IPendingChangeService changes)
    {
        _session = session;
        _changes = changes;
    }

    public IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin)
    {
        var repo = RequireRepository();
        return repo.GetRecords("worldspace", plugin, null, WorldspaceListLimit, 0).Items
            .Select(r => new WorldspaceSummary(r.FormKey, r.EditorId))
            .ToList();
    }

    public WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey)
    {
        var cells = RequireRepository().GetWorldspaceCells(plugin, worldspaceFormKey);

        // A worldspace's TopCell (persistent interior cell) has no block/sub-block coordinates.
        var topCellRow = cells.FirstOrDefault(c => c.BlockX == null);
        var topCell = topCellRow == null
            ? null
            : new CellSummary(topCellRow.FormKey, topCellRow.EditorId, topCellRow.CellX, topCellRow.CellY);

        var blocks = cells
            .Where(c => c.BlockX != null)
            .GroupBy(c => (X: c.BlockX!.Value, Y: c.BlockY ?? 0))
            .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
            .Select(blockGroup => new WorldspaceBlockDto(
                blockGroup.Key.X, blockGroup.Key.Y,
                blockGroup
                    .GroupBy(c => (X: c.SubX ?? 0, Y: c.SubY ?? 0))
                    .OrderBy(g => g.Key.X).ThenBy(g => g.Key.Y)
                    .Select(subGroup => new WorldspaceSubBlockDto(
                        subGroup.Key.X, subGroup.Key.Y,
                        subGroup
                            .Select(c => new CellSummary(c.FormKey, c.EditorId, c.CellX, c.CellY))
                            .ToList()))
                    .ToList()))
            .ToList();

        return new WorldspaceBlocks(blocks, topCell);
    }

    public CellReferences GetCellReferences(string plugin, string cellFormKey)
    {
        var committed = RequireRepository().GetCellReferences(plugin, cellFormKey);
        var pluginChanges = _changes.GetChanges(plugin);

        if (pluginChanges.Count == 0)
            return committed;

        var deleted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var persistentAdded = new List<PlacedSummary>();
        var temporaryAdded = new List<PlacedSummary>();

        foreach (var c in pluginChanges)
        {
            if (c.ChangeType == PendingChangeConstants.DeleteChangeType)
                deleted.Add(c.FormKey);
            else if (c.ChangeType == PendingChangeConstants.CreateChangeType
                     && string.Equals(c.ParentCell, cellFormKey, StringComparison.OrdinalIgnoreCase))
            {
                var summary = new PlacedSummary(c.FormKey, null, null, c.RecordType);
                if (c.PlacementGroup == PendingChangeConstants.PlacementGroupPersistent)
                    persistentAdded.Add(summary);
                else if (c.PlacementGroup == PendingChangeConstants.PlacementGroupTemporary)
                    temporaryAdded.Add(summary);
            }
        }

        if (deleted.Count == 0 && persistentAdded.Count == 0 && temporaryAdded.Count == 0)
            return committed;

        return new CellReferences(
            committed.Persistent
                .Where(r => !deleted.Contains(r.FormKey))
                .Concat(persistentAdded)
                .ToList(),
            committed.Temporary
                .Where(r => !deleted.Contains(r.FormKey))
                .Concat(temporaryAdded)
                .ToList());
    }

    public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset) =>
        RequireRepository().GetInteriorCells(plugin, limit, offset);

    private IRecordReader RequireRepository() =>
        _session.Repository ?? throw new InvalidOperationException("No session loaded.");
}
