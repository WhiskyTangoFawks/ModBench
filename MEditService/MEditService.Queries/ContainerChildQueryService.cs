using MEditService.Index;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Queries;

/// <summary>Container-child rows (a Quest's topics/branches/scenes, a Dialog Topic's responses),
/// hydrated through the ordinary Search path so IsWinner/WorkingTreeState/LoadOrderIndex derive
/// exactly as every other listing does — no second derivation to keep in step.</summary>
public sealed class ContainerChildQueryService(
    IQueryIndex index, LoadOrderHolder loadOrder, ILogger<ContainerChildQueryService>? logger = null)
{
    private const int UnlimitedRecords = int.MaxValue;

    private readonly IQueryIndex _index = index;
    private readonly LoadOrderHolder _loadOrder = loadOrder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    // The children xEdit nests under a quest (wbVWDAsQuestChildren: DIAL, DLBR, SCEN) and a topic
    // (INFO). A Cell/Worldspace slot isn't here, so a call against one answers empty rather than
    // guessing.
    private static readonly Dictionary<string, string> SlotRecordTypes = new(StringComparer.Ordinal)
    {
        ["DialogTopics"] = "dial",
        ["DialogBranches"] = "dlbr",
        ["Scenes"] = "scen",
        ["Responses"] = "info",
    };

    // ADR-0012: origin — a caller that already knows which plugin named `plugin` it's browsing
    // (a tree row built from one) states it explicitly, else it's resolved from the load order.
    public IReadOnlyList<ContainerChildSummary> GetChildren(string plugin, string parentFormKey, string? origin = null)
    {
        origin ??= PluginOriginResolver.Resolve(_loadOrder.Require(), plugin);
        var repo = _index.RequireReads();
        var pluginKey = new PluginAddress(plugin, origin);

        var rows = repo.GetContainerChildren(pluginKey, parentFormKey)
            .Where(r => SlotRecordTypes.ContainsKey(r.SlotName))
            .ToList();
        if (rows.Count == 0) return [];

        // One Search per record type present, so hydration shares every other listing's derivation.
        var byFormKey = new Dictionary<string, RecordSummary>(StringComparer.Ordinal);
        foreach (var recordType in rows.Select(r => SlotRecordTypes[r.SlotName]).Distinct(StringComparer.Ordinal))
        {
            var page = repo.Search(new RecordQuery(
                RecordTypes: [recordType], Plugin: pluginKey.Name, Origin: pluginKey.Origin, Limit: UnlimitedRecords, Offset: 0));
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
                    row.ChildFormKey, parentFormKey, plugin, origin, SlotRecordTypes[row.SlotName]);
                continue;
            }
            result.Add(new ContainerChildSummary(
                record.FormKey, record.EditorId, record.Plugin, record.Origin,
                record.LoadOrderIndex, record.IsWinner, record.WorkingTreeState, SlotRecordTypes[row.SlotName],
                record.HasContainerChildren, record.ParseDiagnosis, record.HasParseFailure, record.FullName));
        }
        return result;
    }
}
