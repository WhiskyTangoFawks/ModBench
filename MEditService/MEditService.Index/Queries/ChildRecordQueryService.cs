using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Index.Queries;

/// <summary>The destinations that hold any of one record's child records.</summary>
public sealed record HoldingDestinations(RecordAt Record, IReadOnlyList<PluginAddress> Destinations);

/// <summary>What a copy asks before it runs: which records have child records, and which destinations
/// already hold any of them (plugins.md, Copy).</summary>
public sealed class ChildRecordQueryService
{
    private readonly IQueryIndex _index;

    internal ChildRecordQueryService(IQueryIndex index) => _index = index;

    public IReadOnlyList<RecordAt> WithChildRecords(IReadOnlyList<RecordAt> records)
    {
        var reads = _index.RequireReads();
        return [.. records.Where(record => reads.HasChildRecords(record.Plugin, record.FormKey))];
    }

    /// <summary>Throws <see cref="NoLoadOrderException"/> until every plugin is indexed: a destination
    /// not yet reached holds no rows and would read as holding nothing.</summary>
    public IReadOnlyList<HoldingDestinations> DestinationsHoldingChildRecords(
        IReadOnlyList<RecordAt> records, IReadOnlyList<PluginAddress> destinations)
    {
        var reads = _index.RequireReads();
        if (_index.Status.State != LoadOrderState.Ready)
            throw new NoLoadOrderException("The load order is still being indexed.");

        return
        [
            .. records.Select(record =>
            {
                var holders = reads.PluginsHoldingChildRecords(record.Plugin, record.FormKey);
                return new HoldingDestinations(record, [.. destinations.Where(holders.Contains)]);
            }),
        ];
    }
}
