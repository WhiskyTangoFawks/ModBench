using MEditService.Http.Tests.TestSupport;
using MEditService.Index;
using MEditService.Queries;
using MEditService.Tests;

namespace MEditService.Http.Tests.Records;

/// <summary>A read is never queued behind an in-flight write. That a write takes the gate is
/// pinned as the Index's own module fact by
/// <c>IndexWriteGateTests.ASecondCaller_EntersOnlyAfterTheFirstReleases</c>.</summary>
public sealed class IndexWriteSerializationTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IndexProjector Index => _mod.Index;

    private IRecordQueryService Reads() =>
        new RecordQueryService(_mod.Index, _mod.Holder, SharedSchemaReflector.Instance, new ConflictClassifier());

    // Generous, not a proof: a slow CI box must not turn "was served" into a failure. What proves
    // the read was never gated is that it completes at all while the write gate below is held.
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task ARecordListing_IsServedWhileAnUnrelatedWriteHoldsTheGate()
    {
        PagedResult<RecordSummary>? listing = null;
        using var _ = new GateHeldElsewhere(Index.WriteGate);

        var read = Task.Run(() => listing = Reads().GetRecords(type: null, plugin: null, search: null, limit: 500, offset: 0));

        await read.WaitAsync(Generous);
        Assert.NotNull(listing);
        Assert.NotEmpty(listing.Items);
    }
}
