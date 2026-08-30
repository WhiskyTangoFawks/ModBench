using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Plugins;

/// <summary>
/// #274 / ADR-0035: the load order answers while it is still loading. Each test drives a load to a
/// known point with <see cref="GatedIndexRepositoryFactory"/>, asserts what is observable at that
/// instant, then releases it — no sleeps, no timing assumptions.
/// </summary>
public sealed class LoadOrderMirrorProgressiveLoadTests
{
    private static (LoadOrderMirror Manager, GatedIndexRepositoryFactory Gate) MakeGatedManager(string gateBefore)
    {
        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var gate = new GatedIndexRepositoryFactory(inner, gateBefore);
        var manager = new LoadOrderMirror(gate);
        return (manager, gate);
    }

    /// <summary>Three plugins with one NPC each, so a plugin's record count is a known literal
    /// rather than something the assertion recomputes from the mod it is checking.</summary>
    private static ScatteredFixtureData ThreePlugins(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

    [Fact]
    public async Task MidLoad_AnAlreadyIndexedPluginIsQueryable_WhileLaterPluginsAreStillLoading()
    {
        using var fx = ThreePlugins("sm-progressive-queryable");
        var (manager, gate) = MakeGatedManager(gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // Parked before B.esp is indexed: the load order exists, and A.esp — indexed one step ago — is
        // fully queryable. Before #274 there was nothing to ask: the load order was published only
        // after the whole load order had been indexed and swept.
        Assert.NotNull(manager.LoadOrder);
        Assert.NotNull(manager.Repository);
        Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("A.esp", PluginOrigin.DataDirectory))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        // And B.esp — the one being indexed right now — reads as absent rather than half-there.
        Assert.Equal(0, manager.Repository!.GetRecordTypeCounts(new PluginKey("B.esp", PluginOrigin.DataDirectory))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);

        gate.Release();
        await load;

        Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("B.esp", PluginOrigin.DataDirectory))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
    }

    [Fact]
    public async Task Status_ReportsTheLoadWhileItRuns_AndSettlesWhenTheSweepCompletes()
    {
        using var fx = ThreePlugins("sm-progressive-status");
        var (manager, gate) = MakeGatedManager(gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        Assert.Equal(LoadOrderState.None, manager.Status.State);

        var load = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        var loading = manager.Status;
        Assert.Equal(LoadOrderState.Reconciling, loading.State);
        Assert.Equal(3, loading.TotalPlugins);
        Assert.Equal(["Fallout4.esm", "A.esp"], loading.IndexedPlugins.Select(p => p.Name));
        // The whole reason this ticket exists: conflict information is not merely absent here, it is
        // *reported* absent. Nothing downstream may read an unmarked record as conflict-free.
        Assert.False(loading.ConflictsComputed);

        gate.Release();
        await load;

        var ready = manager.Status;
        Assert.Equal(LoadOrderState.Ready, ready.State);
        Assert.Equal(["Fallout4.esm", "A.esp", "B.esp"], ready.IndexedPlugins.Select(p => p.Name));
        Assert.True(ready.ConflictsComputed);
        Assert.Empty(ready.Failures);

        manager.Close();
        Assert.Equal(LoadOrderState.None, manager.Status.State);
    }

    [Fact]
    public async Task Status_ReportsAPluginFailure_WhileTheLoadIsStillRunning()
    {
        using var fx = new PluginFixtureBuilder("sm-progressive-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();

        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var gate = new GatedIndexRepositoryFactory(inner, gateBefore: "B.esp", poisonPlugin: "A.esp");
        using var manager = new LoadOrderMirror(gate);

        var load = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // A.esp failed one step ago and C.esp has not been reached: the failure is reported at the
        // moment it happens, not banked until the load returns. ADR-0026 — a user watching a
        // ninety-second load should not learn at second ninety that something broke at second five.
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
        using var fx = ThreePlugins("sm-progressive-status-origin");
        var (manager, gate) = MakeGatedManager(gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();
        gate.Release();
        await load;

        // #271 / #275: a plugin is identified by (origin, filename) together. A status contract that
        // shipped bare filenames would be a new surface reintroducing the identity this codebase
        // spent four tickets removing.
        Assert.All(manager.Status.IndexedPlugins, p => Assert.False(string.IsNullOrWhiteSpace(p.Origin)));
    }

    [Fact]
    public async Task MidLoad_EnumeratingThePluginList_SurvivesTheLoadAppendingToIt()
    {
        // Four plugins, gated on the third: a plugin is appended to the list when it is *opened*,
        // one step before it is indexed, so parking before B's index leaves C.esp — and only C.esp —
        // still to be appended. Gate on the last plugin and nothing mutates the list after the park,
        // which is how the first version of this test passed while exercising nothing.
        using var fx = new PluginFixtureBuilder("sm-progressive-enumeration")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();
        var (manager, gate) = MakeGatedManager(gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // GetPlugins, PluginOriginResolver, RequirePlugin and BuildTypedLinkCache all walk this list,
        // and until #274 nothing could append to it while they did. Interleaved exactly rather than
        // raced: begin an enumeration, let the load open one more plugin, then keep enumerating —
        // which is the shape that throws on a plain List<T>, deterministically.
        var plugins = manager.LoadOrder!.Plugins;
        using var enumerator = plugins.GetEnumerator();
        Assert.True(enumerator.MoveNext());

        gate.Release();
        await load;

        var rest = 1;
        while (enumerator.MoveNext()) rest++;
        Assert.True(rest >= 1);
    }

    /// <summary>Four plugins, so gating on the third leaves one the load has not reached.</summary>
    private static ScatteredFixtureData FourPlugins(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("FromC"))
            .BuildScattered();

    [Fact]
    public async Task UnloadMidLoad_StopsTheLoad_AndLeavesNoLoadOrderBehind()
    {
        using var fx = FourPlugins("sm-progressive-unload");
        var (manager, gate) = MakeGatedManager(gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // Unload has to wait for the load to stop touching the repository before disposing it —
        // disposing a DuckDB connection out from under an in-flight index is a native crash, not an
        // exception, and it would take the whole backend down with the user's loaded load order.
        var unload = Task.Run(manager.Close);
        var premature = await Task.WhenAny(unload, Task.Delay(TimeSpan.FromMilliseconds(500)));
        Assert.NotSame(unload, premature); // disposed while the load was still running

        gate.Release();
        await unload;
        await Assert.ThrowsAsync<OperationCanceledException>(() => load);

        Assert.Null(manager.LoadOrder);
        Assert.Null(manager.Repository);
        Assert.Equal(LoadOrderState.None, manager.Status.State);
        // The load stopped where it was told to rather than running to completion first.
        Assert.DoesNotContain("C.esp", gate.Created.Single().Indexed);
        Assert.True(gate.Created.Single().Disposed);
    }

    [Fact]
    public async Task ASecondLoadMidLoad_DrainsTheFirst_AndTheSurvivorIsWhollyTheSecond()
    {
        using var fx = FourPlugins("sm-progressive-supersede");
        var (manager, gate) = MakeGatedManager(gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var first = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // A second snapshot while a reconcile is running is an ordinary event (a watcher firing
        // during activation), not an edge case.
        var second = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        var premature = await Task.WhenAny(second, Task.Delay(TimeSpan.FromMilliseconds(500)));
        Assert.NotSame(second, premature); // the second reconcile waited for the first to stop

        gate.Release();
        await Assert.ThrowsAsync<OperationCanceledException>(() => first);
        await second;

        // ADR-0044: the same instance is reconciled in place — one index, not a second one that
        // replaces the first. What the superseded reconcile had landed stays; its successor picks
        // up where it stopped and finishes the set, so nothing is indexed twice.
        var index = Assert.Single(gate.Created);
        Assert.False(index.Disposed);
        Assert.Equal(LoadOrderState.Ready, manager.Status.State);
        Assert.Equal(["Fallout4.esm", "A.esp", "B.esp", "C.esp"], manager.Status.IndexedPlugins.Select(p => p.Name));
        Assert.True(index.WinnersComputed);
        Assert.Equal(["Fallout4.esm", "A.esp", "B.esp", "C.esp"], index.Indexed);
        Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("C.esp", PluginOrigin.DataDirectory))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
    }

    [Fact]
    public async Task MidLoad_ReadsAreServed_RatherThanBlockingUntilTheLoadFinishes()
    {
        using var fx = ThreePlugins("sm-progressive-nonblocking");
        var (manager, gate) = MakeGatedManager(gateBefore: "B.esp");
        using var _ = manager;
        using var __ = gate;

        var load = Task.Run(() => manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // The regression this pins: the load used to hold the load order lock end to end, so this read
        // did not return wrong data — it returned nothing at all until the whole load order had been
        // indexed and swept. A timeout is the only way to tell "answered" from "eventually answered".
        var read = Task.Run(() =>
        {
            var repo = manager.Repository;
            return repo == null ? (int?)null : repo.GetRecordTypeCounts(new PluginKey("A.esp", PluginOrigin.DataDirectory))
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0;
        });
        var finished = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(5)));

        Assert.Same(read, finished); // timed out = a read is blocked behind the load again
        Assert.Equal(1, await read);

        gate.Release();
        await load;
    }
}
