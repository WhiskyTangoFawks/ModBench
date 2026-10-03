using MEditService.Http.Tests.TestSupport;
using MEditService.Index;
using MEditService.Queries;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Records;

public sealed class IndexWriteSerializationTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private Indexer Index => _mod.Index;

    private IRecordQueryService Reads() =>
        new RecordQueryService(_mod.Index, _mod.Holder, SharedSchemaReflector.Instance, new ConflictClassifier());

    private static readonly TimeSpan SlowCiMachineTolerance = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task ARecordListing_IsServedWhileAnUnrelatedWriteHoldsTheGate()
    {
        PagedResult<RecordSummary>? listing = null;
        using var _ = new GateHeldElsewhere(Index.WriteGate);

        var read = Task.Run(() => listing = Reads().GetRecords(type: null, plugin: null, search: null, limit: 500, offset: 0));

        await read.WaitAsync(SlowCiMachineTolerance);
        Assert.NotNull(listing);
        Assert.NotEmpty(listing.Items);
    }
}
