using MEditService.Commands.Edits;
using MEditService.PluginAdapter;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Index;
using MEditService.Codec.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Query;

/// <summary>Master issues derive from the whole loaded set, so mid-load they are wrong, not merely
/// incomplete: a healthy plugin whose master is not yet opened would read as missing (the same
/// class of error ADR-0013 names).</summary>
public sealed class MasterIssuesDuringLoadTests
{
    [Fact]
    public async Task GetPlugins_MidLoad_DoesNotFlagAMasterThatSimplyHasNotBeenOpenedYet()
    {
        var holder = new LoadOrderHolder();
        // ADR-0008: a genuine FormKey reference is what makes Mutagen record a master. Later.esm is
        // sequenced after the plugin depending on it, the transient state every ordinary load passes
        // through, held still here by the gate.
        using var fx = new PluginFixtureBuilder("mi-midload")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("NeedsLater").Race.SetTo(
                new FormKey(ModKey.FromFileName("Later.esm"), 0x800)))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .WithPlugin("Later.esm", mod => mod.Races.AddNew("LaterRace"))
            .BuildScattered();

        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var gate = new GatedIndexRepositoryFactory(inner, gateBefore: "B.esp");
        using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, gate);
        var svc = new RecordQueryService(
            manager, holder, reflector, new ConflictClassifier());

        var load = Task.Run(() => manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // Parked with A.esp open and Later.esm not yet reached.
        var midLoad = svc.GetPlugins();
        Assert.Contains(midLoad, p => p.Name == "A.esp");
        Assert.DoesNotContain(midLoad, p => p.Name == "Later.esm");
        Assert.All(midLoad, p => Assert.Empty(p.MasterIssues ?? []));

        gate.Release();
        await load;

        // And once the load is complete the answer is real again — this suppresses the claim while
        // it cannot be made, it does not abandon it.
        var loaded = svc.GetPlugins();
        Assert.Contains(loaded, p => p.Name == "Later.esm");
        Assert.All(loaded, p => Assert.Empty(p.MasterIssues ?? []));
    }

    [Fact]
    public void GetPlugins_AfterLoad_StillReportsAGenuinelyMissingMaster()
    {
        var holder = new LoadOrderHolder();
        // The guard against fixing the false positive by simply never reporting anything.
        using var fx = new PluginFixtureBuilder("mi-genuine")
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .Build();
        var reflector = SharedSchemaReflector.Instance;
        using var manager = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        manager.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var svc = new RecordQueryService(
            manager, holder, reflector, new ConflictClassifier());

        var patch = svc.GetPlugins().Single(p => p.Name == "Patch.esp");
        Assert.Contains(patch.MasterIssues ?? [], i => i.MasterName == "Ghost.esm");
    }
}
