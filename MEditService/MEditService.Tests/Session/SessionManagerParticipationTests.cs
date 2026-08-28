using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Session;

// #97 / ADR-0035 § Live mutation: the checkbox gesture — flips a load-order member's participation
// (the plugins.txt `*` prefix) in the running session, SQL-only, no re-read and no re-index. Same
// lock/busy-guard shape as SessionManagerRereadPluginTests' own RereadPlugin coverage, since the
// two share the exact check-and-act pattern.
public sealed class SessionManagerParticipationTests
{
    private static SessionManager MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory);
    }

    [Fact]
    public void SetPluginParticipation_FlipsTheFlag_SessionReportsIt()
    {
        using var fx = new PluginFixtureBuilder("sm-participation-flip")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
            Assert.True(manager.Session!.Plugins.Single(p => p.Name == "A.esp").Participates);

            var response = sessionManager.SetPluginParticipation("A.esp", false);

            Assert.False(response.Participates);
            Assert.False(manager.Session!.Plugins.Single(p => p.Name == "A.esp").Participates);
        }
    }

    // AC2/AC6: the whole-set winner re-sweep — a plugin that stops participating stops
    // contesting, and the record's other provider becomes the sole winner. This is the proof that
    // SetPluginParticipation actually calls UpdateWinners rather than just flipping the flag.
    [Fact]
    public void SetPluginParticipation_FlipToDisabled_TheOtherProviderBecomesTheWinner()
    {
        using var fx = new PluginFixtureBuilder("sm-participation-winner")
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("B.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("A.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .BuildScattered();

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            var formKey = manager.Repository!
                .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey("A.esm"), Limit: 10, Offset: 0))
                .Items.Single().FormKey;

            // B.esp starts as the winner — it loads after A.esm and both participate.
            var beforeStack = manager.Repository!.GetOverrideStack(formKey)!.Entries;
            Assert.True(beforeStack.Single(o => o.Plugin.Name == "B.esp").IsWinner);

            sessionManager.SetPluginParticipation("B.esp", false);

            var afterStack = manager.Repository!.GetOverrideStack(formKey)!.Entries;
            Assert.False(afterStack.Single(o => o.Plugin.Name == "B.esp").IsWinner);
            Assert.True(afterStack.Single(o => o.Plugin.Name == "A.esm").IsWinner);
        }
    }

    // Rival named: an implementation that reopens/re-reads the plugin file to flip participation
    // (rather than a pure SQL UPDATE + in-memory metadata swap) would throw FileNotFoundException
    // once the file is gone. This proves the mutation never touches disk again after load.
    [Fact]
    public void SetPluginParticipation_AfterThePluginFileIsDeletedFromDisk_StillSucceeds()
    {
        using var fx = new PluginFixtureBuilder("sm-participation-no-reread")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            var path = fx.Plugins.Single(p => p.Name == "A.esp").Path;
            File.Delete(path);

            var response = sessionManager.SetPluginParticipation("A.esp", false);

            Assert.False(response.Participates);
        }
    }

    [Fact]
    public async Task SetPluginParticipation_WhileALoadIsInFlight_IsRefusedWithoutDisturbingTheLoad()
    {
        using var fx = new PluginFixtureBuilder("sm-participation-busy")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"), origin: "ModA")
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var gate = new GatedIndexRepositoryFactory(inner, gateBefore: "B.esp");
        using var manager = new SessionManager(gate);
        ISessionManager sessionManager = manager;

        var load = Task.Run(() => sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // Parked mid-load with A.esp already indexed — so the refusal is for being mid-load, not
        // for having nothing to act on.
        Assert.Throws<SessionBusyException>(() => sessionManager.SetPluginParticipation("A.esp", false));

        gate.Release();
        await load;

        // The load finished on its own terms and the plugin still holds its original participation.
        Assert.True(manager.Session!.Plugins.Single(p => p.Name == "A.esp").Participates);
    }

    [Fact]
    public void SetPluginParticipation_PluginTheSessionDoesNotHold_Throws()
    {
        using var fx = new PluginFixtureBuilder("sm-participation-unknown")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            Assert.Throws<KeyNotFoundException>(() => sessionManager.SetPluginParticipation("Absent.esp", false));
        }
    }

    [Fact]
    public void SetPluginParticipation_NoSession_Throws()
    {
        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            Assert.Throws<InvalidOperationException>(() => sessionManager.SetPluginParticipation("A.esp", false));
        }
    }
}
