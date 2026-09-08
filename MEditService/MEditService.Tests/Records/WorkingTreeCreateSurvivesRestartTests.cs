using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
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
    [Fact]
    public void ARecordCreated_ButNeverCompiled_IsStillReadable_AfterARestart()
    {
        using var mod = IndexedModFixture.Tracked();
        var created = ProjectingEditService.Over(mod.Mirror)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");
        Assert.True(created.Applied, created.Message);

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            mod.GameDirectory,
            [new LoadOrderEntry(IndexedModFixture.PluginName, Path.Combine(mod.ModFolder, IndexedModFixture.PluginName), IndexedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        // A silently-failed source ingest degrades to the binary, which never held this uncompiled create,
        // so "the record is not found" reads identically whether ingest never ran or genuinely excluded
        // it.
        Assert.Empty(((ILoadOrderMirror)reloaded).Status.Failures);
        var reread = reloaded.Index!.At(RecordRef.Effective).GetDocument(created.NewFormKey!, mod.Plugin);
        Assert.NotNull(reread);
        Assert.Equal("SurvivesRestart", reread!.EditorId);
        Assert.Null(reloaded.Index!.At(RecordRef.Head).GetDocument(created.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void ARecordCreated_IsWinner_AfterARestart()
    {
        using var mod = IndexedModFixture.Tracked();
        var created = ProjectingEditService.Over(mod.Mirror)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            mod.GameDirectory,
            [new LoadOrderEntry(IndexedModFixture.PluginName, Path.Combine(mod.ModFolder, IndexedModFixture.PluginName), IndexedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        // Regression guard, same reasoning as the sibling test above.
        Assert.Empty(((ILoadOrderMirror)reloaded).Status.Failures);
        // The rival: a sweep that inserts the row but forgets winner resweep (or runs before the
        // whole-load-order UpdateWinners() at the end of the load loop) leaves it_winner false.
        Assert.True(reloaded.Index!.At(RecordRef.Effective).GetDocument(created.NewFormKey!)!.IsWinner);
    }
}
