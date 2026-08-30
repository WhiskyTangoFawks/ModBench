using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// #417 B11 / AC4: the load-time hash check. A binary changed while no watcher was ever running
/// (the "Modbench was closed" case) is still caught the moment a reconciles, through the same
/// <see cref="MEditService.Core.Source.ExternalChangeClassifier"/> the live watcher itself calls.
///
/// <para>#381: the same pass's crash-repair offers — an interrupted compile (an unanswered
/// <see cref="CompileJournal"/> marker) and a binary that cannot be read at all — both routed away
/// from the external-change dialog's own queue (<see cref="ExternalChangeWatcher.Unanswered"/>).</para>
/// </summary>
public sealed class ExternalChangeLoadOrderHookTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void RunAfterReconcile_QueuesAnExternalChange_ForABinaryThatChangedWithNoWatcherEverRunning()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        // Never watched before this call — exactly "closed" means: no FileSystemWatcher instance
        // has ever seen this write happen.
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
        Assert.Empty(offers); // #381: clean state produces no repair activity either.
    }

    // #381 AC1: a crash between the journal's marker write and its clear (simulated the same way
    // PluginCompileServiceJournalTests does — a real CompileJournal.RunBatch that throws partway —
    // is detected as an interrupted compile at the next load, offered for repair, and never routed
    // into the external-change dialog's own queue (#417 comment 2: "the two prompts must never both
    // fire for one event").
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

    // #381 addition 2: the repo and source survive, only the plugin's own binary is gone — reachable
    // without the repo being destroyed (ADR-0041's "reads as untracked" case is a different, already-
    // handled path). Before this ticket the read failure was logged and dropped with nothing offered.
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

    // #381 AC3: an untracked plugin is never probed at all, even in the exact repair-worthy state
    // (a missing binary) that offers repair for a tracked one — TrackedOf's own early-continue is
    // what this guards, and it is what makes the rest of this hook's body unreachable for it.
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
