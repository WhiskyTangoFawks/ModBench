using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Queries;

/// <summary>Container-child rows (a Quest's topics/branches/scenes, a Dialog Topic's responses),
/// hydrated through the ordinary Search path so IsWinner/WorkingTreeState/LoadOrderIndex derive
/// exactly as every other listing does — no second derivation to keep in step.</summary>
internal static class ContainerChildren
{
    private const int UnlimitedRecords = int.MaxValue;

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

    public static IReadOnlyList<ContainerChildSummary> Of(RelationReads repo, PluginAddress plugin, string parentFormKey, GameRelease release)
    {
        var rows = repo.GetHoldings(plugin, parentFormKey)
            .Where(r => SlotRecordTypes.ContainsKey(r.Slot))
            .ToList();
        if (rows.Count == 0) return [];

        // One Search per record type present, so hydration shares every other listing's derivation.
        var byFormKey = new Dictionary<string, RecordSummary>(StringComparer.Ordinal);
        foreach (var recordType in rows.Select(r => SlotRecordTypes[r.Slot]).Distinct(StringComparer.Ordinal))
        {
            var page = repo.Search(new RecordQuery(
                RecordQueryScope.Navigator, RecordTypes: [recordType], Plugin: plugin.Name, Origin: plugin.Origin, Limit: UnlimitedRecords, Offset: 0));
            foreach (var record in page.Items) byFormKey[record.FormKey] = record;
        }

        var result = new List<ContainerChildSummary>(rows.Count);
        foreach (var row in rows)
        {
            // The two reads are two snapshots: a child a commit took between them is gone, and that
            // commit's announcement asks for this listing again.
            if (!byFormKey.TryGetValue(row.Child, out var record)) continue;
            result.Add(new ContainerChildSummary(
                record.FormKey, record.EditorId, record.Plugin, record.Origin,
                record.LoadOrderIndex, record.IsWinner, record.WorkingTreeState, SlotRecordTypes[row.Slot],
                record.HasContainerChildren, record.ParseDiagnosis, record.HasParseFailure, record.FullName,
                RecordTypes.For(release).HasChildSlots(SlotRecordTypes[row.Slot])));
        }
        return result;
    }
}
