using System.Collections.Concurrent;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

public sealed class ProgressiveIndexingTests
{
    private static (OpenedIndex Index, GatedPluginAdapter Gate) OpenGatedIndex(LoadOrderHolder holder, string gateBefore)
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
    public async Task MidLoad_AnIndexedPluginIsQueryable_AndTheOneBeingIndexedReadsAbsent_WhileLaterPluginsAreStillLoading()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-queryable");
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;

        var load = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        Assert.Equal(1, index.CountOf(new PluginAddress("A.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.Equal(0, index.CountOf(new PluginAddress("B.esp", PluginOrigin.DataDirectory), "npc_"));

        gate.Release();
        await load;

        Assert.Equal(1, index.CountOf(new PluginAddress("B.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public async Task Status_ReportsTheLoadWhileItRuns_AndSettlesWhenTheSweepCompletes()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-status");
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;

        Assert.Equal(LoadOrderState.None, index.Status.State);

        var load = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        var loading = index.Status;
        Assert.Equal(LoadOrderState.Reconciling, loading.State);
        Assert.Equal(3, loading.TotalPlugins);
        Assert.Equal(["Master.esm", "A.esp"], loading.IndexedPlugins.Select(p => p.Name));
        Assert.False(loading.ConflictsComputed);

        gate.Release();
        await load;

        var ready = index.Status;
        Assert.Equal(LoadOrderState.Ready, ready.State);
        Assert.Equal(["Master.esm", "A.esp", "B.esp"], ready.IndexedPlugins.Select(p => p.Name));
        Assert.True(ready.ConflictsComputed);
        Assert.Empty(ready.Failures);

        index.Dispose();
        Assert.Equal(LoadOrderState.None, index.Status.State);
    }

    [Fact]
    public async Task Status_ReportsAPluginFailure_WhileTheLoadIsStillRunning_AndAfterItFinishes()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-progressive-failure")
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();

        using var gate = new GatedPluginAdapter(gateBefore: "B.esp", poisonPlugin: "A.esp");
        using var index = Indexes.Open(holder, gate);

        var load = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        var status = index.Status;
        Assert.Equal(LoadOrderState.Reconciling, status.State);
        var failure = Assert.Single(status.Failures);
        Assert.Equal("A.esp", failure.Name);
        Assert.DoesNotContain(status.IndexedPlugins, p => p.Name == "C.esp");

        gate.Release();
        await load;

        Assert.Contains(index.Status.Failures, f => f.Name == "A.esp");
    }

    [Fact]
    public async Task Status_IndexedPluginsCarryOrigin_NotJustAFilename()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-status-origin");
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;

        var load = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();
        gate.Release();
        await load;

        Assert.All(index.Status.IndexedPlugins, p => Assert.False(string.IsNullOrWhiteSpace(p.Origin)));
    }

    private static ScatteredFixtureData FourPlugins(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();

    [Fact]
    public async Task UnloadMidLoad_EntersOnlyAfterTheLoadStops()
    {
        var holder = new LoadOrderHolder();
        using var fx = FourPlugins("sm-progressive-unload");
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;
        var order = new ConcurrentQueue<string>();

        holder.Apply(LoadOrderArrival.Snapshot(fx.GameDirectory, null, GameRelease.Fallout4, fx.Plugins));
        await gate.WaitUntilParkedAsync();

        using var unloadAttempting = new ManualResetEventSlim();
        var unload = Task.Run(() =>
        {
            unloadAttempting.Set();
            index.Dispose();
            order.Enqueue("unload-done");
        });
        Assert.True(unloadAttempting.Wait(TimeSpan.FromSeconds(5)));

        gate.Release();
        order.Enqueue("gate-released");
        await unload;

        Assert.Equal(["gate-released", "unload-done"], order);
        Assert.Equal(IndexRefusal.NoLoadOrder, index.Queries.GetPlugins().Refused().Refusal);
        Assert.Equal(LoadOrderState.None, index.Status.State);
        Assert.DoesNotContain("C.esp", gate.Opened);
    }

    [Fact]
    public async Task ASecondLoadMidLoad_DrainsTheFirst_ReconcilesInPlace_AndTheSurvivorIsWhollyTheSecond()
    {
        var holder = new LoadOrderHolder();
        using var fx = FourPlugins("sm-progressive-supersede");
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;
        var order = new ConcurrentQueue<string>();

        var first = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        using var secondAttempting = new ManualResetEventSlim();
        var second = Task.Run(() =>
        {
            secondAttempting.Set();
            index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
            order.Enqueue("second-done");
        });
        Assert.True(secondAttempting.Wait(TimeSpan.FromSeconds(5)));

        gate.Release();
        order.Enqueue("gate-released");
        await first;
        await second;

        Assert.Equal(["gate-released", "second-done"], order);
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.Equal(["Master.esm", "A.esp", "B.esp", "C.esp"], index.Status.IndexedPlugins.Select(p => p.Name));
        Assert.True(index.Status.ConflictsComputed);
        Assert.Equal(["Master.esm", "A.esp", "B.esp", "C.esp"], gate.Opened);
        Assert.Equal(1, index.CountOf(new PluginAddress("C.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public async Task ANewPluginInASnapshotArrivingMidReconcile_IsIndexed_AndTheParkedWorkSurvives()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-progressive-arriving-plugin")
            .WithPlugin("Master.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .WithPlugin("Minted.esp", mod => mod.Npcs.AddNew("FromMinted"))
            .BuildScattered();
        var beforeTheCreate = fx.Plugins.Where(p => p.Name != "Minted.esp").ToList();
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;

        var first = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, beforeTheCreate, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        var second = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        Assert.True(
            await Waits.Until(() => holder.Current.Plugins.Count == 5),
            "the arriving snapshot never reached the holder");
        Assert.Equal(LoadOrderState.Reconciling, index.Status.State);
        Assert.Equal(0, index.CountOf(new PluginAddress("Minted.esp", PluginOrigin.DataDirectory), "npc_"));

        gate.Release();
        await first;
        await second;

        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.True(index.Status.ConflictsComputed);
        Assert.Equal(
            ["Master.esm", "A.esp", "B.esp", "C.esp", "Minted.esp"],
            index.Status.IndexedPlugins.Select(p => p.Name));
        Assert.Equal(["Master.esm", "A.esp", "B.esp", "C.esp", "Minted.esp"], gate.Opened);
        Assert.Equal(1, index.CountOf(new PluginAddress("Minted.esp", PluginOrigin.DataDirectory), "npc_"));
        Assert.Equal(1, index.CountOf(new PluginAddress("A.esp", PluginOrigin.DataDirectory), "npc_"));
    }

    [Fact]
    public async Task MidLoad_AListingSortsItsRecordsByLoadPosition_WithALightPluginsLast()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-progressive-order")
            .WithPlugin("Zulu.esm", mod => mod.Activators.AddNew("CZuluLever"))
            .WithPlugin("Alpha.esl", mod => mod.Activators.AddNew("AAlphaLever"))
            .WithPlugin("Beta.esm", mod => mod.Activators.AddNew("BBetaLever"))
            .WithPlugin("Patch.esp", (mod, masters) =>
            {
                foreach (var master in masters) mod.Activators.GetOrAddAsOverride(master.Activators.Single());
            })
            .WithPlugin("Late.esp")
            .BuildScattered();
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "Late.esp");
        using var _ = index;
        using var __ = gate;

        var load = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        var patch = fx.Plugins.Single(p => p.Name == "Patch.esp").KeyOf();
        var listed = index.Queries.GetRecords(["acti"], patch, search: null, limit: 10, offset: 0).Value().Items.Select(r => r.EditorId);

        Assert.Equal(["CZuluLever", "BBetaLever", "AAlphaLever"], listed);

        gate.Release();
        await load;
    }

    [Fact]
    public async Task MidLoad_ReadsAreServed_RatherThanBlockingUntilTheLoadFinishes()
    {
        var holder = new LoadOrderHolder();
        using var fx = ThreePlugins("sm-progressive-nonblocking");
        var (index, gate) = OpenGatedIndex(holder, gateBefore: "B.esp");
        using var _ = index;
        using var __ = gate;

        var load = Task.Run(() => index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        var read = Task.Run(() => index.CountOf(new PluginAddress("A.esp", PluginOrigin.DataDirectory), "npc_"));
        var finished = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(5)));

        Assert.Same(read, finished);
        Assert.Equal(1, await read);

        gate.Release();
        await load;
    }
}
