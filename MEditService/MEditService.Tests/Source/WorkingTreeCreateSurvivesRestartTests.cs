using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// A working-tree-only create must survive a backend restart before the record is ever compiled: it
/// answers at Effective, and at Head it answers nothing at all, because no commit holds it yet.
///
/// <para>These two assertions are exactly what tells "ingest-from-source produces this state on its
/// own" apart from "the state stopped being produced"; the second of them (Head answers nothing)
/// goes red the moment ingest seeds both refs from one whole-tree read, and is what
/// <c>IRecordIndex.MarkWorkingTreeOnly</c> exists to put right.</para>
///
/// <para>Reloads the same mod folder in a brand-new <see cref="LoadOrderMirror"/> — the honest way to
/// prove "survives a restart" rather than asserting anything about the first load order's own state.</para>
/// </summary>
public sealed class WorkingTreeCreateSurvivesRestartTests
{
    [Fact]
    public void ARecordCreated_ButNeverCompiled_IsStillReadable_AfterARestart()
    {
        using var mod = TrackedModFixture.Tracked();
        var created = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");
        Assert.True(created.Applied, created.Message);

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            mod.GameDirectory,
            [new LoadOrderEntry(TrackedModFixture.PluginName, Path.Combine(mod.ModFolder, TrackedModFixture.PluginName), TrackedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        // Regression guard: a silently-failed source ingest degrades to the binary (which never
        // held this uncompiled create), so the assertions below would pass for the wrong reason —
        // "the record isn't found" reads identically whether ingest never ran or genuinely excluded
        // it. This caught a real one: git show HEAD:<path> glob-matches a missing bracketed "[N] "
        // path instead of failing, so a fresh, never-committed record's own Head lookup silently came
        // back "" instead of null (SourceRepository.ReadCommittedSourceText's own doc comment).
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.LoadFailures);
        var reread = reloaded.Index!.GetDocument(created.NewFormKey!, mod.Plugin);
        Assert.NotNull(reread);
        Assert.Equal("SurvivesRestart", reread!.EditorId);
        Assert.Null(reloaded.Index!.At(RecordRef.Head).GetDocument(created.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void ARecordCreated_IsWinner_AfterARestart()
    {
        using var mod = TrackedModFixture.Tracked();
        var created = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            mod.GameDirectory,
            [new LoadOrderEntry(TrackedModFixture.PluginName, Path.Combine(mod.ModFolder, TrackedModFixture.PluginName), TrackedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        // Regression guard, same reasoning as the sibling test above.
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.LoadFailures);
        // The rival: a sweep that inserts the row but forgets winner resweep (or runs before the
        // whole-load-order UpdateWinners() at the end of the load loop) leaves it_winner false.
        Assert.True(reloaded.Index!.GetDocument(created.NewFormKey!)!.IsWinner);
    }
}
