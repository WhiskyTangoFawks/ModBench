using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Core.Queries;

/// <summary>
/// Per-plugin container-child read (#424) — a Quest's dialog topics/branches/scenes, a Dialog
/// Topic's responses, as first-class record rows the Plugins tree expands a Quest/DialogTopic row
/// into. Reads the <c>container_child</c> side table (<see cref="IRecordReads.GetContainerChildren"/>,
/// built by #416/#450/#488 for a different consumer — <c>RecordEditService</c>'s delete/renumber
/// containment guard) and hydrates each row through the ordinary <see cref="IRecordReads.Search"/>
/// path, so IsWinner/WorkingTreeState/LoadOrderIndex/EditorId are derived exactly the way every
/// other record listing already derives them — no second, competing derivation to keep in step.
///
/// <para><b>Order is xEdit's, not the raw table's.</b> <c>container_child</c>'s own
/// <c>ORDER BY slot_name, slot_index</c> is alphabetical (DialogBranches, DialogTopics, Scenes) —
/// fine for that table's own bookkeeping callers, wrong for display. xEdit's Quest children GRUP
/// (type 10, FO4-family only — <c>wbVWDAsQuestChildren</c>) orders DIAL, DLBR, SCEN; a Dialog
/// Topic's INFO children (GRUP type 7) are just Responses, flat, no sub-grouping — xEdit has none
/// either. <see cref="SlotOrder"/> restates that canonical order as data, the same "read xEdit,
/// then encode its answer" posture <c>ContainerChildFields</c> already takes.</para>
///
/// <para>Deliberately container-type-agnostic — nothing here is Quest/DialogTopic-specific beyond
/// <see cref="SlotOrder"/>'s own entries; a future container type is a new row there, not a new
/// service. Cell/Worldspace stay on their own dedicated worldspace-tree surface
/// (<see cref="IWorldspaceQueryService"/>) unchanged — their NavigationMeshes/Landscape/TopCell/
/// SubCells slots aren't in <see cref="SlotOrder"/>, so a call against one of those FormKeys
/// answers empty rather than guessing at a presentation xEdit doesn't use for them here.</para>
/// </summary>
public sealed class ContainerChildQueryService(ILoadOrderMirror loadOrder, ILogger<ContainerChildQueryService>? logger = null)
{
    private const int UnlimitedRecords = int.MaxValue;

    private readonly ILoadOrderMirror _mirror = loadOrder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    // (Order, RecordType) per slot name — xEdit's own presentation order, restated as data.
    private static readonly Dictionary<string, (int Order, string RecordType)> SlotOrder = new(StringComparer.Ordinal)
    {
        ["DialogTopics"] = (0, "dial"),
        ["DialogBranches"] = (1, "dlbr"),
        ["Scenes"] = (2, "scen"),
        ["Responses"] = (0, "info"),
    };

    // #305 / ADR-0036: origin — a caller that already knows which copy of `plugin` it's browsing
    // (a tree row built from one) states it explicitly, else it's resolved from the load order.
    // Mirrors IWorldspaceQueryService's own shape.
    public IReadOnlyList<ContainerChildSummary> GetChildren(string plugin, string parentFormKey, string? origin = null)
    {
        origin ??= PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);
        var repo = RequireReads();
        var pluginKey = new PluginKey(plugin, origin);

        var rows = repo.GetContainerChildren(pluginKey, parentFormKey)
            .Where(r => SlotOrder.ContainsKey(r.SlotName))
            .OrderBy(r => SlotOrder[r.SlotName].Order)
            .ThenBy(r => r.SlotIndex)
            .ToList();
        if (rows.Count == 0) return [];

        // One Search per distinct record type actually present — hydrates IsWinner/
        // WorkingTreeState/LoadOrderIndex/EditorId through the same derivation every other record
        // listing already uses, rather than re-deriving it here.
        var byFormKey = new Dictionary<string, RecordSummary>(StringComparer.Ordinal);
        foreach (var recordType in rows.Select(r => SlotOrder[r.SlotName].RecordType).Distinct(StringComparer.Ordinal))
        {
            var page = repo.Search(new RecordQuery(RecordTypes: [recordType], Plugin: pluginKey, Limit: UnlimitedRecords, Offset: 0));
            foreach (var record in page.Items) byFormKey[record.FormKey] = record;
        }

        var result = new List<ContainerChildSummary>(rows.Count);
        foreach (var row in rows)
        {
            if (!byFormKey.TryGetValue(row.ChildFormKey, out var record))
            {
                // container_child named a child Search didn't return — an index inconsistency
                // between two tables written from the same ingest pass, never expected in
                // practice; this reader degrades by omission rather than throwing.
                _logger.LogWarning(
                    "Container child {ChildFormKey} of {ParentFormKey} in {Plugin} ({Origin}) is indexed in " +
                    "container_child but Search({RecordType}) did not return it; omitting.",
                    row.ChildFormKey, parentFormKey, plugin, origin, SlotOrder[row.SlotName].RecordType);
                continue;
            }
            result.Add(new ContainerChildSummary(
                record.FormKey, record.EditorId, record.Plugin, record.Origin,
                record.LoadOrderIndex, record.IsWinner, record.WorkingTreeState, SlotOrder[row.SlotName].RecordType));
        }
        return result;
    }

    private IRecordReads RequireReads() => _mirror.RequireScope().Reads;
}
