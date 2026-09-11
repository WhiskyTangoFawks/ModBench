using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
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
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void RunAfterReconcile_QueuesAnExternalChange_ForABinaryThatChangedWithNoWatcherEverRunning()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);

        // "Closed" means no FileSystemWatcher instance ever sees this write happen.
        var externalMod = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = 0.9f;
        externalMod.Npcs.AddNew("UntouchedNpc");
        externalMod.WriteToBinary(pluginPath);

        var watcher = new ModFolderWatcher();
        ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Index, _mod.Holder.Current, watcher, NullLogger.Instance);

        var unanswered = Assert.Single(watcher.Unanswered());
        Assert.Equal(_mod.ModFolder, unanswered.ModFolder);
        Assert.Equal([IndexedModFixture.PluginName], unanswered.Classification.Plugins);
    }

    [Fact]
    public void RunAfterReconcile_QueuesNothing_WhenTheBinaryNeverChanged()
    {
        var watcher = new ModFolderWatcher();

        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Index, _mod.Holder.Current, watcher, NullLogger.Instance);

        Assert.Empty(watcher.Unanswered());
        Assert.Empty(offers); // clean state produces no repair activity either.
    }

    // The marker outlived its change (bytes restored by hand, a re-Track, a superseding settle):
    // the classifier is the authority, so a load finding nothing drops it rather than leaving the
    // mod read-only over a question nobody can answer.
    [Fact]
    public void RunAfterReconcile_DropsAStaleMarker_AndQueuesNothing_WhenTheBytesMatchTheParkedSnapshot()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "a question whose change is gone");
        var watcher = new ModFolderWatcher();

        ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Index, _mod.Holder.Current, watcher, NullLogger.Instance);

        Assert.Null(ExternalChangeDeferral.Unanswered(_mod.ModFolder));
        Assert.Empty(watcher.Unanswered());
    }

    // An unreadable binary is a repair offer, and no verdict: the marker it would have cleared stands.
    [Fact]
    public void RunAfterReconcile_KeepsAStaleMarker_WhenTheTrackedPluginCannotBeRead()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "a question the binary cannot answer for now");
        File.Delete(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));
        var watcher = new ModFolderWatcher();

        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Index, _mod.Holder.Current, watcher, NullLogger.Instance);

        Assert.Equal(CrashRepairReason.MissingOrUnreadableBinary, Assert.Single(offers).Reason);
        Assert.NotNull(ExternalChangeDeferral.Unanswered(_mod.ModFolder));
    }

    // A crash between the journal's marker write and its clear is offered for repair and never
    // routed into the external-change queue: the two prompts must never both fire for one event.
    [Fact]
    public void RunAfterReconcile_OffersRepair_AndQueuesNoExternalChangeQuestion_WhenAJournalMarkerIsUnanswered()
    {
        Assert.ThrowsAny<Exception>(() =>
            CompileJournal.RunBatch(_mod.ModFolder, [IndexedModFixture.PluginName],
                _ => throw new InvalidOperationException("simulated crash between source and binary write")));
        Assert.NotNull(CompileJournal.UnfinishedBatch(_mod.ModFolder)); // sanity: the marker really is there.

        var watcher = new ModFolderWatcher();
        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Index, _mod.Holder.Current, watcher, NullLogger.Instance);

        var offer = Assert.Single(offers);
        Assert.Equal(IndexedModFixture.PluginName, offer.Plugin);
        Assert.Equal(IndexedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.InterruptedCompile, offer.Reason);
        Assert.Empty(watcher.Unanswered()); // never the external-change dialog's own question.
    }

    // The repo and source survive, only the plugin's own binary is gone — reachable
    // without the repo being destroyed (ADR-0041's "reads as untracked" case is a different, already-
    // handled path).
    [Fact]
    public void RunAfterReconcile_OffersRepair_WhenTheTrackedPluginsBinaryIsMissing()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);
        File.Delete(pluginPath);

        var watcher = new ModFolderWatcher();
        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Index, _mod.Holder.Current, watcher, NullLogger.Instance);

        var offer = Assert.Single(offers);
        Assert.Equal(IndexedModFixture.PluginName, offer.Plugin);
        Assert.Equal(IndexedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.MissingOrUnreadableBinary, offer.Reason);
        Assert.Empty(watcher.Unanswered());
    }

    // TrackedOf's early-continue makes the rest of the hook's body unreachable for an untracked
    // plugin, even in the repair-worthy state that offers repair for a tracked one.
    [Fact]
    public void RunAfterReconcile_OffersNothing_ForAnUntrackedPlugin_EvenWithAMissingBinary()
    {
        using var untracked = IndexedModFixture.Untracked();
        File.Delete(Path.Combine(untracked.ModFolder, IndexedModFixture.PluginName));

        var watcher = new ModFolderWatcher();
        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(untracked.Index, untracked.Holder.Current, watcher, NullLogger.Instance);

        Assert.Empty(offers);
        Assert.Empty(watcher.Unanswered());
    }

    [Fact]
    public void RunAfterReconcile_RegistersALiveWatch_SoFurtherChangesAreCaughtWithoutAnotherLoad()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);
        var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));

        ExternalChangeLoadOrderHook.RunAfterReconcile(_mod.Index, _mod.Holder.Current, watcher, NullLogger.Instance);
        Assert.Empty(watcher.Unanswered());

        File.WriteAllBytes(pluginPath, "changed-live-after-load"u8.ToArray());

        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < deadline && watcher.Unanswered().Count == 0) Thread.Sleep(20);

        Assert.Single(watcher.Unanswered());
    }
}
