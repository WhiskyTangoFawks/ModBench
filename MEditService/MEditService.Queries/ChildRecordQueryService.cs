using MEditService.Index;
using MEditService.LoadOrder;

namespace MEditService.Queries;

/// <summary>A record and the plugin holding it (ADR-0012).</summary>
public readonly record struct RecordIn(PluginAddress Plugin, string FormKey);

/// <summary>The destinations that hold any of one record's child records.</summary>
public sealed record ChildRecordHolders(RecordIn Record, IReadOnlyList<PluginAddress> Destinations);

/// <summary>What a copy asks before it runs: which records have child records, and which destinations
/// already hold any of them (plugins.md, Copy).</summary>
public sealed class ChildRecordQueryService(IQueryIndex index)
{
    public IReadOnlyList<RecordIn> WithChildRecords(IReadOnlyList<RecordIn> records)
    {
        var reads = index.RequireReads();
        return [.. records.Where(record => reads.HasChildRecords(record.Plugin, record.FormKey))];
    }

    public IReadOnlyList<ChildRecordHolders> HoldersOfChildRecords(
        IReadOnlyList<RecordIn> records, IReadOnlyList<PluginAddress> destinations)
    {
        var reads = index.RequireReads();
        return
        [
            .. records.Select(record =>
            {
                var holders = reads.PluginsHoldingChildRecords(record.Plugin, record.FormKey);
                return new ChildRecordHolders(record, [.. destinations.Where(holders.Contains)]);
            }),
        ];
    }
}
