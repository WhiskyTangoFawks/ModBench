using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

/// <summary>Head answering nothing is what tells "ingest-from-source produces this state" apart from "the
/// state stopped being produced"; it goes red the moment ingest seeds both refs from one whole-tree
/// read.</summary>
public sealed class WorkingTreeCreateSurvivesRestartTests
{
    private static string RequireNewFormKey(RecordEditResult result) =>
        result.NewFormKey ?? throw new InvalidOperationException("Expected a successful create to set NewFormKey.");

    [Fact]
    public void ARecordCreated_ButNeverCompiled_IsStillReadable_AfterARestart()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();
        var created = ProjectingEditService.Over(mod.Index, mod.Holder)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");
        Assert.True(created.Applied, created.Message);

        using var reloaded = Indexes.Open(holder);
        reloaded.Reconcile(holder,
            mod.GameDirectory,
            [new LoadOrderEntry(IndexedModFixture.PluginName, Path.Combine(mod.ModFolder, IndexedModFixture.PluginName), IndexedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        // A silently-failed source ingest degrades to the binary, which never held this uncompiled create,
        // so "the record is not found" reads identically whether ingest never ran or genuinely excluded
        // it.
        Assert.Empty(reloaded.Status.Failures);
        var newFormKey = RequireNewFormKey(created);
        var reloadedStore = reloaded.RequireReads();
        var reread = reloadedStore.GetDocument(newFormKey, mod.Plugin);
        Assert.NotNull(reread);
        Assert.Equal("SurvivesRestart", reread.EditorId);
        Assert.True(reloadedStore.StackEntry(newFormKey, mod.Plugin).Require().HasWorkingTreeChange);
    }

    [Fact]
    public void ARecordCreated_IsWinner_AfterARestart()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.Tracked();
        var created = ProjectingEditService.Over(mod.Index, mod.Holder)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");

        using var reloaded = Indexes.Open(holder);
        reloaded.Reconcile(holder,
            mod.GameDirectory,
            [new LoadOrderEntry(IndexedModFixture.PluginName, Path.Combine(mod.ModFolder, IndexedModFixture.PluginName), IndexedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        // Regression guard, same reasoning as the sibling test above.
        Assert.Empty(reloaded.Status.Failures);
        // The rival: a sweep that inserts the row but forgets winner resweep (or runs before the
        // whole-load-order UpdateWinners() at the end of the load loop) leaves it_winner false.
        var newFormKey = RequireNewFormKey(created);
        var document = reloaded.RequireReads().GetDocument(newFormKey)
            ?? throw new InvalidOperationException($"Expected {newFormKey} to resolve to a document.");
        Assert.True(document.IsWinner);
    }
}
