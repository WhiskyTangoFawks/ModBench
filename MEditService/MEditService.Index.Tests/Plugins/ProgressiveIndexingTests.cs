using System.Collections.Concurrent;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

/// <summary>Each test drives a load to a known point with <see cref="GatedPluginAdapter"/> and
/// asserts at that instant: no sleeps, no timing assumptions (ADR-0013).</summary>
public sealed class ProgressiveIndexingTests
{
    private static (IndexProjector Manager, GatedPluginAdapter Gate) MakeGatedManager(LoadOrderHolder holder, string gateBefore)
    {
        var gate = new GatedPluginAdapter(gateBefore);
        return (Indexes.Open(holder, gate), gate);
    }

    private static ScatteredFixtureData ThreePlugins(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

    [Fact]
    public async Task MidLoad_AnAlreadyIndexedPluginIsQueryable_WhileLaterPluginsAreStillLoading()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-queryable");
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // Parked before B.esp is indexed: the load order exists, and A.esp — indexed one step ago — is
        // fully queryable — not published only after the whole load order has been indexed and swept.
        var reads = manager.RequireReads();
        Assert.Equal(1, reads.CountOf(new PluginCopyKey("A.esp", PluginOrigin.DataDirectory), "npc_"));
        // And B.esp — the one being indexed right now — reads as absent rather than half-there.
        Assert.Equal(0, reads.CountOf(new PluginCopyKey("B.esp", PluginOrigin.DataDirectory), "npc_"));

        gate.Release();
        await load;

        var readsAfterLoad = manager.RequireReads();
        Assert.Equal(1, readsAfterLoad.CountOf(new PluginCopyKey("B.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public async Task Status_ReportsTheLoadWhileItRuns_AndSettlesWhenTheSweepCompletes()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-status");
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        Assert.Equal(LoadOrderState.None, manager.Status.State);

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        var loading = manager.Status;
        Assert.Equal(LoadOrderState.Reconciling, loading.State);
        Assert.Equal(3, loading.TotalPlugins);
        Assert.Equal(["Master.esm", "A.esp"], loading.IndexedPlugins.Select(p => p.Name));
        // Conflict information is not merely absent here, it is
        // *reported* absent. Nothing downstream may read an unmarked record as conflict-free.
        Assert.False(loading.ConflictsComputed);

        gate.Release();
        await load;

        var ready = manager.Status;
        Assert.Equal(LoadOrderState.Ready, ready.State);
        Assert.Equal(["Master.esm", "A.esp", "B.esp"], ready.IndexedPlugins.Select(p => p.Name));
        Assert.True(ready.ConflictsComputed);
        Assert.Empty(ready.Failures);

        manager.Dispose();
        Assert.Equal(LoadOrderState.None, manager.Status.State);
    }

    [Fact]
    public async Task Status_ReportsAPluginFailure_WhileTheLoadIsStillRunning()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-progressive-failure")
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();

        using var gate = new GatedPluginAdapter(gateBefore: "B.esp", poisonPlugin: "A.esp");
        using var manager = Indexes.Open(holder, gate);

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // A.esp failed one step ago and C.esp has not been reached: the failure is reported when it
        // happens, not banked until the load returns.
        var status = manager.Status;
        Assert.Equal(LoadOrderState.Reconciling, status.State);
        var failure = Assert.Single(status.Failures);
        Assert.Equal("A.esp", failure.Name);
        Assert.DoesNotContain(status.IndexedPlugins, p => p.Name == "C.esp");

        gate.Release();
        await load;

        // And the finished load still reports it — surfacing early does not consume it.
        Assert.Contains(manager.Status.Failures, f => f.Name == "A.esp");
    }

    [Fact]
    public async Task Status_IndexedPluginsCarryOrigin_NotJustAFilename()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-status-origin");
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();
        gate.Release();
        await load;

        // A plugin is identified by (origin, filename) together. A status contract that
        // shipped bare filenames would be a new surface reintroducing bare-filename identity.
        Assert.All(manager.Status.IndexedPlugins, p => Assert.False(string.IsNullOrWhiteSpace(p.Origin)));
    }

    [Fact]
    public async Task MidLoad_EnumeratingThePluginList_SurvivesTheLoadAppendingToIt()
    {
        var holder = new LoadOrderHolder();
        // A plugin is appended when it is opened, one step before it is indexed, so parking before
        // B's index leaves only C.esp still to be appended.
        using var fx = new PluginFixtureBuilder("sm-progressive-enumeration")
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // Interleaved exactly rather than raced: begin an enumeration, let the load open one more plugin,
        // then keep enumerating, which is the shape that throws on a plain List<T>, deterministically.
        var reads = manager.RequireReads();
        var opened = reads.OpenedCopies;
        using var enumerator = opened.GetEnumerator();
        Assert.True(enumerator.MoveNext());

        gate.Release();
        await load;

        var rest = 1;
        while (enumerator.MoveNext()) rest++;
        Assert.True(rest >= 1);
    }

    private static ScatteredFixtureData FourPlugins(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();

    // Absence by order, never by elapsed time: disposing under an in-flight load is a native
    // crash, so "unload-done" must land only after the main thread has released the parked load.
    [Fact]
    public async Task UnloadMidLoad_EntersOnlyAfterTheLoadStops()
    {
        var holder = new LoadOrderHolder();
        using var fx = FourPlugins("sm-progressive-unload");
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;
        var order = new ConcurrentQueue<string>();

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        using var unloadAttempting = new ManualResetEventSlim();
        var unload = Task.Run(() =>
        {
            unloadAttempting.Set();
            manager.Dispose();
            order.Enqueue("unload-done");
        });
        Assert.True(unloadAttempting.Wait(TimeSpan.FromSeconds(5)));

        gate.Release();
        order.Enqueue("gate-released");
        await unload;
        await load;

        Assert.Equal(["gate-released", "unload-done"], order);
        Assert.Throws<NoLoadOrderException>(() => manager.RequireReads());
        Assert.Equal(LoadOrderState.None, manager.Status.State);
        // The load stopped where it was told to rather than running to completion first.
        Assert.DoesNotContain("C.esp", gate.Opened);
    }

    // Absence by order, never by elapsed time: "second-done" must land only after the main
    // thread has released the parked first reconcile.
    [Fact]
    public async Task ASecondLoadMidLoad_DrainsTheFirst_AndTheSurvivorIsWhollyTheSecond()
    {
        var holder = new LoadOrderHolder();
        using var fx = FourPlugins("sm-progressive-supersede");
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;
        var order = new ConcurrentQueue<string>();

        var first = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();
        var readsWhileParked = manager.RequireReads();

        // A second snapshot while a reconcile is running is an ordinary event (a watcher firing
        // during activation), not an edge case.
        using var secondAttempting = new ManualResetEventSlim();
        var second = Task.Run(() =>
        {
            secondAttempting.Set();
            manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
            order.Enqueue("second-done");
        });
        Assert.True(secondAttempting.Wait(TimeSpan.FromSeconds(5)));

        gate.Release();
        order.Enqueue("gate-released");
        await first;
        await second;

        Assert.Equal(["gate-released", "second-done"], order);
        // ADR-0013: the same instance is reconciled in place, one index rather than a second replacing the
        // first. What the superseded reconcile landed stays, and its successor finishes the set.
        Assert.Same(readsWhileParked, manager.RequireReads());
        Assert.Equal(LoadOrderState.Ready, manager.Status.State);
        Assert.Equal(["Master.esm", "A.esp", "B.esp", "C.esp"], manager.Status.IndexedPlugins.Select(p => p.Name));
        Assert.True(manager.Status.ConflictsComputed);
        Assert.Equal(["Master.esm", "A.esp", "B.esp", "C.esp"], gate.Opened);
        Assert.Equal(1, manager.RequireReads().CountOf(new PluginCopyKey("C.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public async Task ANewCopyInASnapshotArrivingMidReconcile_IsIndexed_AndTheParkedWorkSurvives()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-progressive-arriving-copy")
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .WithPlugin("Minted.esp", mod => mod.Npcs.AddNew("FromMinted"))
            .BuildScattered();
        var beforeTheCreate = fx.Plugins.Where(p => p.Name != "Minted.esp").ToList();
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var first = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, beforeTheCreate, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();
        var readsWhileParked = manager.RequireReads();

        // ADR-0007: a create registers its copy on the holder before the Index hears of it, so the
        // arriving snapshot names a copy the parked reconcile never knew about.
        var second = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        // The five-copy snapshot reaches the holder before the gate opens, so the second reconcile
        // is genuinely mid-flight rather than a sequential third act the release let through.
        Assert.True(
            await Waits.Until(() => holder.Current.Copies.Count == 5),
            "the arriving snapshot never reached the holder");
        // Caught in flight: the holder already names five copies while the parked Index still
        // answers for four, which is the instant this test exists to cover.
        Assert.Equal(LoadOrderState.Reconciling, manager.Status.State);
        Assert.Equal(0, readsWhileParked.CountOf(new PluginCopyKey("Minted.esp", PluginOrigin.DataDirectory), "npc_"));

        gate.Release();
        // Superseded or run to completion: once the gate opens, either ordering is the projector's
        // to choose and everything below holds for both.
        await first;
        await second;

        Assert.Same(readsWhileParked, manager.RequireReads());
        Assert.Equal(LoadOrderState.Ready, manager.Status.State);
        Assert.True(manager.Status.ConflictsComputed);
        Assert.Equal(
            ["Master.esm", "A.esp", "B.esp", "C.esp", "Minted.esp"],
            manager.Status.IndexedPlugins.Select(p => p.Name));
        // Opened once each across both reconciles: the arriving snapshot adds a copy to the scope
        // rather than restarting it.
        Assert.Equal(["Master.esm", "A.esp", "B.esp", "C.esp", "Minted.esp"], gate.Opened);
        Assert.Equal(1, manager.RequireReads().CountOf(new PluginCopyKey("Minted.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.Equal(1, manager.RequireReads().CountOf(new PluginCopyKey("A.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public async Task MidLoad_ReadsAreServed_RatherThanBlockingUntilTheLoadFinishes()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-nonblocking");
        var (manager, gate) = MakeGatedManager(holder, gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // A load holding the load order lock end to end returns nothing at all until the whole load order
        // is indexed and swept. A timeout is the only way to tell "answered" from "eventually answered".
        var read = Task.Run(() => manager.RequireReads().CountOf(new PluginCopyKey("A.esp", PluginOrigin.DataDirectory), "npc_"));
        var finished = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(5)));

        Assert.Same(read, finished); // timed out = a read is blocked behind the load again
        Assert.Equal(1, await read);

        gate.Release();
        await load;
    }
}
