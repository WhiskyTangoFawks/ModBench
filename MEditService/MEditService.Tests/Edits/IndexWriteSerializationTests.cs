using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #673: the gate's call sites, against a real tracked load order — which of them take
/// <see cref="IndexWriteGate"/> and, just as load-bearing, which of them must not.
///
/// <para>Every test here works the same way, because a concurrency test that merely races two
/// callers and hopes proves nothing: the gate is <i>held</i> by a helper thread for the whole
/// measurement, and the call under test is then either observed to block (it takes the gate) or
/// observed to finish anyway (it does not). No sleep decides the outcome, so removing the gate
/// flips the assertion rather than making it flaky.</para>
/// </summary>
public sealed class IndexWriteSerializationTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private ILoadOrderMirror Mirror => _mod.Mirror;

    private IRecordQueryService Reads() =>
        new RecordQueryService(_mod.Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());

    private SourceFreshness Freshness() =>
        new(_mod.Mirror, NullLogger<SourceFreshness>.Instance, new RecordTextCodec(NullLogger<RecordTextCodec>.Instance));

    /// <summary>
    /// Holds the write gate on a helper thread for as long as the returned handle lives — the one
    /// mechanic every test here shares. Deliberately not on the calling thread: the gate is
    /// reentrant, so a test that took it itself would observe nothing.
    /// </summary>
    private sealed class GateHeldElsewhere : IDisposable
    {
        private readonly ManualResetEventSlim _release = new();
        private readonly Task _holder;

        public GateHeldElsewhere(IndexWriteGate gate)
        {
            var held = new ManualResetEventSlim();
            _holder = Task.Run(() =>
            {
                using var _ = gate.Enter();
                held.Set();
                _release.Wait(TimeSpan.FromSeconds(30));
            });
            if (!held.Wait(TimeSpan.FromSeconds(10)))
                throw new InvalidOperationException("The helper thread never took the gate.");
            held.Dispose();
        }

        public void Dispose()
        {
            _release.Set();
            _holder.GetAwaiter().GetResult();
            _release.Dispose();
        }
    }

    /// <summary>Runs <paramref name="work"/> on a background thread and says whether it finished
    /// within <paramref name="within"/>. The task is returned so the caller can let it finish once
    /// the gate is released.</summary>
    private static (Task Work, bool Finished) RunAndWait(Action work, TimeSpan within)
    {
        var task = Task.Run(work);
        return (task, task.Wait(within));
    }

    private static readonly TimeSpan BlockedWindow = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    // --- AC2: the external-change watcher's timer-driven index writes take the gate ---

    /// <summary>
    /// <c>UnindexPlugin</c> is what the watcher's timer calls (via <c>IndexMirror.Apply</c>) when a
    /// mirrored binary vanishes. It writes to the index from outside any request.
    /// </summary>
    [Fact]
    public async Task UnindexPlugin_WaitsForAnInFlightWriteToRelease()
    {
        Task work;
        using (new GateHeldElsewhere(Mirror.WriteGate))
        {
            bool finished;
            (work, finished) = RunAndWait(() => Mirror.UnindexPlugin(_mod.Plugin), BlockedWindow);
            Assert.False(finished, "UnindexPlugin wrote to the index without taking the write gate");
        }

        await work.WaitAsync(Generous);
    }

    /// <summary>
    /// #672's door, reached from the same timer for a <i>tracked</i> plugin — <c>ReindexPlugin</c>
    /// branches into it rather than opening the binary. It re-derives a whole source tree into the
    /// index, which is the longest single write the gate holds.
    /// </summary>
    [Fact]
    public async Task ReingestPluginFromSource_WaitsForAnInFlightWriteToRelease()
    {
        Task work;
        using (new GateHeldElsewhere(Mirror.WriteGate))
        {
            bool finished;
            (work, finished) = RunAndWait(() => Mirror.ReingestPluginFromSource(_mod.Plugin), BlockedWindow);
            Assert.False(finished, "ReingestPluginFromSource wrote to the index without taking the write gate");
        }

        await work.WaitAsync(Generous);
    }

    // --- AC3: the read-path freshness self-heal takes the gate only when it is about to write ---

    /// <summary>
    /// The whole reason the gate is taken around the self-heal's write rather than around the pass:
    /// the pass runs per record on every read, and on the overwhelmingly common path it finds
    /// nothing to fold in. A gate around the read-and-compare would put every point read behind
    /// every edit.
    /// </summary>
    [Fact]
    public void FreshnessValidate_WithNoDrift_NeverAcquiresTheGate()
    {
        var freshness = Freshness();
        freshness.Validate(_mod.Npc.ToString()); // settle any first-read self-heal before measuring

        using var _ = new GateHeldElsewhere(Mirror.WriteGate);
        var (_, finished) = RunAndWait(() => freshness.Validate(_mod.Npc.ToString()), BlockedWindow);

        Assert.True(finished, "a drift-free read acquired the write gate");
    }

    /// <summary>The other side of the same coin: the moment it has something to fold in, it is a
    /// write and it queues like one.</summary>
    [Fact]
    public async Task FreshnessValidate_WithDrift_WaitsForAnInFlightWriteToRelease()
    {
        var freshness = Freshness();
        freshness.Validate(_mod.Npc.ToString());

        // An edit made outside Modbench, exactly as ReadTimeFreshnessTests makes them.
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));
        Assert.NotEqual(text, File.ReadAllText(_mod.NpcSourceFile)); // the drift is real, not a no-op replace

        Task work;
        using (new GateHeldElsewhere(Mirror.WriteGate))
        {
            bool finished;
            (work, finished) = RunAndWait(() => freshness.Validate(_mod.Npc.ToString()), BlockedWindow);
            Assert.False(finished, "the self-heal folded a change into the index without taking the write gate");
        }

        await work.WaitAsync(Generous);
    }

    // --- AC4: reads are never serialized behind a write ---

    [Fact]
    public void ARecordListing_IsServedWhileAnUnrelatedWriteHoldsTheGate()
    {
        using var _ = new GateHeldElsewhere(Mirror.WriteGate);

        PagedResult<RecordSummary>? listing = null;
        var (_, finished) = RunAndWait(
            () => listing = Reads().GetRecords(type: null, plugin: null, search: null, limit: 500, offset: 0),
            BlockedWindow);

        Assert.True(finished, "a record listing queued behind an in-flight write");
        Assert.NotEmpty(listing!.Items);
    }
}
