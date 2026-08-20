using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Query;

/// <summary>
/// #274: master issues are derived from the whole loaded set, so mid-load they are not merely
/// incomplete — they are wrong. A plugin whose master is real, present on disk and simply not opened
/// yet classifies as <c>DirectlyMissing</c> against a partial session, which would put a red "missing
/// master" decoration on a healthy plugin for as long as the load takes.
///
/// The same class of error as an absent conflict badge reading as "no conflict", and ADR-0035 names
/// only the latter — this is the one the code review of that ADR did not catch.
/// </summary>
public sealed class MasterIssuesDuringLoadTests
{
    [Fact]
    public async Task GetPlugins_MidLoad_DoesNotFlagAMasterThatSimplyHasNotBeenOpenedYet()
    {
        // ADR-0038: a genuine FormKey reference is what makes Mutagen record a master for real.
        // Later.esm is sequenced after the plugin that depends on it, which is exactly the transient
        // state every ordinary load passes through — here it is merely held still by the gate.
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
        using var manager = new SessionManager(gate);
        var svc = new RecordQueryService(
            manager, reflector, new ConflictClassifier());

        var load = Task.Run(() => manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
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
        // The guard against fixing the false positive by simply never reporting anything.
        using var fx = new PluginFixtureBuilder("mi-genuine")
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .Build();
        var reflector = SharedSchemaReflector.Instance;
        using var manager = new SessionManager(
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        manager.Load(fx.DataFolder, fx.PluginsTxtPath, GameRelease.Fallout4);
        var svc = new RecordQueryService(
            manager, reflector, new ConflictClassifier());

        var patch = svc.GetPlugins().Single(p => p.Name == "Patch.esp");
        Assert.Contains(patch.MasterIssues ?? [], i => i.MasterName == "Ghost.esm");
    }
}
