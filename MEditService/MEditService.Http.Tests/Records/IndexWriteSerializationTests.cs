using MEditService.Http.Tests.Edits;
using MEditService.Http.Tests.TestSupport;
using MEditService.Index;
using MEditService.Queries;
using MEditService.Tests;
using MEditService.Tests.TestSupport;

namespace MEditService.Http.Tests.Records;

/// <summary>The gate is held by a helper thread for the whole measurement and the call under test is
/// observed to block or finish; no sleep decides the outcome.</summary>
public sealed class IndexWriteSerializationTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IndexProjector Index => _mod.Index;

    private string PluginPath => Path.Combine(_mod.ModFolder, _mod.ActualPluginName);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_mod.Index, _mod.Holder, SharedSchemaReflector.Instance, new ConflictClassifier());

    private static (Task Work, bool Finished) RunAndWait(Action work, TimeSpan within)
    {
        var task = Task.Run(work);
        return (task, task.Wait(within));
    }

    // Two windows on purpose. BlockedWindow is short, because the helper holds the gate far longer and
    // a gateless call finishes in milliseconds. ServedWindow is generous, because a slow CI box must
    // not turn "was served" into a failure.
    private static readonly TimeSpan BlockedWindow = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan ServedWindow = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    // --- AC2: the external-change watcher's timer-driven index writes take the gate ---

    [Fact]
    public async Task RefreshBinary_OfAGoneFile_WaitsForAnInFlightWriteToRelease()
    {
        File.Delete(PluginPath);
        Task work;
        using (new GateHeldElsewhere(Index.WriteGate))
        {
            bool finished;
            (work, finished) = RunAndWait(() => Index.RefreshBinary(_mod.Plugin, PluginPath).GetAwaiter().GetResult(), BlockedWindow);
            Assert.False(finished, "the gone-file refresh wrote to the index without taking the write gate");
        }

        await work.WaitAsync(Generous);
    }

    [Fact]
    public async Task RefreshBinary_OfChangedBytes_WaitsForAnInFlightWriteToRelease()
    {
        PluginBinaries.Touch(PluginPath);
        Task work;
        using (new GateHeldElsewhere(Index.WriteGate))
        {
            bool finished;
            (work, finished) = RunAndWait(() => Index.RefreshBinary(_mod.Plugin, PluginPath).GetAwaiter().GetResult(), BlockedWindow);
            Assert.False(finished, "the changed-bytes refresh wrote to the index without taking the write gate");
        }

        await work.WaitAsync(Generous);
    }

    // --- The other two live index writes, found by review rather than named in the ticket ---

    [Fact]
    public async Task SetFilter_WaitsForAnInFlightWriteToRelease()
    {
        Task work;
        using (new GateHeldElsewhere(Index.WriteGate))
        {
            bool finished;
            (work, finished) = RunAndWait(() => Index.SetFilter("SELECT form_key FROM records"), BlockedWindow);
            Assert.False(finished, "SetFilter materialized _filter without taking the write gate");
        }

        await work.WaitAsync(Generous);
    }

    // --- The Source watcher's own timer-driven index write (ADR-0015 invariant 2) ---

    [Fact]
    public async Task RefreshKeys_WaitsForAnInFlightWriteToRelease()
    {
        Task work;
        using (new GateHeldElsewhere(Index.WriteGate))
        {
            bool finished;
            (work, finished) = RunAndWait(
                () => Index.RefreshKeys(_mod.Plugin, [_mod.Npc.ToString()]), BlockedWindow);
            Assert.False(finished, "RefreshKeys wrote to the index without taking the write gate");
        }

        await work.WaitAsync(Generous);
    }

    // --- AC4: reads are never serialized behind a write ---

    [Fact]
    public void ARecordListing_IsServedWhileAnUnrelatedWriteHoldsTheGate()
    {
        using var _ = new GateHeldElsewhere(Index.WriteGate);

        PagedResult<RecordSummary>? listing = null;
        var (_, finished) = RunAndWait(
            () => listing = Reads().GetRecords(type: null, plugin: null, search: null, limit: 500, offset: 0),
            ServedWindow);

        Assert.True(finished, "a record listing queued behind an in-flight write");
        Assert.NotNull(listing);
        Assert.NotEmpty(listing.Items);
    }
}
