using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>A binary changed while no watcher was running (Modbench closed) is caught when a load
/// order reconciles, through the same classifier the live watcher calls; crash-repair offers are
/// routed away from the external-change dialog's queue.</summary>
public sealed class ExternalChangeLoadOrderHookTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void RunAfterReconcile_QueuesAnExternalChange_ForABinaryThatChangedWithNoWatcherEverRunning()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        // "Closed" means no FileSystemWatcher instance ever sees this write happen.
        var externalMod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = 0.9f;
        externalMod.Npcs.AddNew("UntouchedNpc");
        externalMod.WriteToBinary(pluginPath);

        var watcher = new ExternalChangeWatcher();
        ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Mirror.LoadOrder, _mod.Mirror.Index, watcher, NullLogger.Instance);

        var unanswered = Assert.Single(watcher.Unanswered());
        Assert.Equal(_mod.ModFolder, unanswered.ModFolder);
        Assert.Equal(TrackedModFixture.PluginName, unanswered.PluginName);
    }

    [Fact]
    public void RunAfterReconcile_QueuesNothing_WhenTheBinaryNeverChanged()
    {
        var watcher = new ExternalChangeWatcher();

        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Mirror.LoadOrder, _mod.Mirror.Index, watcher, NullLogger.Instance);

        Assert.Empty(watcher.Unanswered());
        Assert.Empty(offers); // clean state produces no repair activity either.
    }

    // A crash between the journal's marker write and its clear is offered for repair and never
    // routed into the external-change queue: the two prompts must never both fire for one event.
    [Fact]
    public void RunAfterReconcile_OffersRepair_AndQueuesNoExternalChangeQuestion_WhenAJournalMarkerIsUnanswered()
    {
        Assert.ThrowsAny<Exception>(() =>
            CompileJournal.RunBatch(_mod.ModFolder, [TrackedModFixture.PluginName],
                _ => throw new InvalidOperationException("simulated crash between source and binary write")));
        Assert.NotNull(CompileJournal.UnfinishedBatch(_mod.ModFolder)); // sanity: the marker really is there.

        var watcher = new ExternalChangeWatcher();
        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Mirror.LoadOrder, _mod.Mirror.Index, watcher, NullLogger.Instance);

        var offer = Assert.Single(offers);
        Assert.Equal(TrackedModFixture.PluginName, offer.Plugin);
        Assert.Equal(TrackedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.InterruptedCompile, offer.Reason);
        Assert.Empty(watcher.Unanswered()); // never the external-change dialog's own question.
    }

    // The repo and source survive, only the plugin's own binary is gone — reachable
    // without the repo being destroyed (ADR-0041's "reads as untracked" case is a different, already-
    // handled path).
    [Fact]
    public void RunAfterReconcile_OffersRepair_WhenTheTrackedPluginsBinaryIsMissing()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        File.Delete(pluginPath);

        var watcher = new ExternalChangeWatcher();
        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Mirror.LoadOrder, _mod.Mirror.Index, watcher, NullLogger.Instance);

        var offer = Assert.Single(offers);
        Assert.Equal(TrackedModFixture.PluginName, offer.Plugin);
        Assert.Equal(TrackedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.MissingOrUnreadableBinary, offer.Reason);
        Assert.Empty(watcher.Unanswered());
    }

    // TrackedOf's early-continue makes the rest of the hook's body unreachable for an untracked
    // plugin, even in the repair-worthy state that offers repair for a tracked one.
    [Fact]
    public void RunAfterReconcile_OffersNothing_ForAnUntrackedPlugin_EvenWithAMissingBinary()
    {
        using var untracked = TrackedModFixture.Untracked();
        File.Delete(Path.Combine(untracked.ModFolder, TrackedModFixture.PluginName));

        var watcher = new ExternalChangeWatcher();
        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(untracked.Mirror.LoadOrder, untracked.Mirror.Index, watcher, NullLogger.Instance);

        Assert.Empty(offers);
        Assert.Empty(watcher.Unanswered());
    }

    [Fact]
    public void RunAfterReconcile_RegistersALiveWatch_SoFurtherChangesAreCaughtWithoutAnotherLoad()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));

        ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Mirror.LoadOrder, _mod.Mirror.Index, watcher, NullLogger.Instance);
        Assert.Empty(watcher.Unanswered());

        File.WriteAllBytes(pluginPath, "changed-live-after-load"u8.ToArray());

        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < deadline && watcher.Unanswered().Count == 0) Thread.Sleep(20);

        Assert.Single(watcher.Unanswered());
    }
}
