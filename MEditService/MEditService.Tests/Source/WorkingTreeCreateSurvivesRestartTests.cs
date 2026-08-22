using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// A working-tree-only create must survive a backend restart before the record is ever compiled: it
/// answers at Effective, and at Head it answers nothing at all, because no commit holds it yet.
///
/// <para><b>Kept deliberately when #452 deleted the class it was written for</b> (#427 Epic B′'s
/// <c>WorkingTreeCreateRediscovery</c>). AC4 deletes the reconciliation sweep, not the behaviour it
/// was reconciling toward — and a deletion slice that also deletes its own safety net proves nothing.
/// These two assertions are exactly what tells "ingest-from-source produces this state on its own"
/// apart from "the state stopped being produced"; the second of them (Head answers nothing) is what
/// went red the moment ingest started seeding both refs from one whole-tree read, and what
/// <c>IRecordIndex.MarkWorkingTreeOnly</c> exists to put right.</para>
///
/// <para>Reloads the same mod folder in a brand-new <see cref="SessionManager"/> — the honest way to
/// prove "survives a restart" rather than asserting anything about the first session's own state.</para>
/// </summary>
public sealed class WorkingTreeCreateSurvivesRestartTests
{
    [Fact]
    public void ARecordCreated_ButNeverCompiled_IsStillReadable_AfterASessionRestart()
    {
        using var mod = TrackedModFixture.Tracked();
        var created = new RecordEditService(mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");
        Assert.True(created.Applied, created.Message);

        using var reloaded = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)reloaded).LoadExplicit(
            mod.GameDirectory,
            [new ExplicitPluginInput(
                TrackedModFixture.PluginName,
                Path.Combine(mod.ModFolder, TrackedModFixture.PluginName),
                TrackedModFixture.ModFolderOrigin,
                true)],
            GameRelease.Fallout4);

        // #459 regression guard: a silently-failed source ingest degrades to the binary (which never
        // held this uncompiled create), so the assertions below would pass for the wrong reason —
        // "the record isn't found" reads identically whether ingest never ran or genuinely excluded
        // it. This caught a real one: git show HEAD:<path> glob-matches a missing bracketed "[N] "
        // path instead of failing, so a fresh, never-committed record's own Head lookup silently came
        // back "" instead of null (SourceRepository.ReadCommittedSourceText's own doc comment).
        Assert.Empty(((ISessionManager)reloaded).Session!.LoadFailures);
        var reread = reloaded.Index!.GetDocument(created.NewFormKey!, mod.Plugin);
        Assert.NotNull(reread);
        Assert.Equal("SurvivesRestart", reread!.EditorId);
        Assert.Null(reloaded.Index!.At(RecordRef.Head).GetDocument(created.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void ARecordCreated_IsWinner_AfterASessionRestart()
    {
        using var mod = TrackedModFixture.Tracked();
        var created = new RecordEditService(mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .CreateRecord(mod.Plugin, "npc_", "SurvivesRestart");

        using var reloaded = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)reloaded).LoadExplicit(
            mod.GameDirectory,
            [new ExplicitPluginInput(
                TrackedModFixture.PluginName,
                Path.Combine(mod.ModFolder, TrackedModFixture.PluginName),
                TrackedModFixture.ModFolderOrigin,
                true)],
            GameRelease.Fallout4);

        // #459 regression guard, same reasoning as the sibling test above.
        Assert.Empty(((ISessionManager)reloaded).Session!.LoadFailures);
        // The rival: a sweep that inserts the row but forgets winner resweep (or runs before the
        // whole-session UpdateWinners() at the end of the load loop) leaves it_winner false.
        Assert.True(reloaded.Index!.GetDocument(created.NewFormKey!)!.IsWinner);
    }
}
