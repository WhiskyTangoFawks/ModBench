using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Session;

/// <summary>
/// #427 Epic B′: a working-tree-only create must survive a backend restart before the record is ever
/// compiled — <c>IRecordIndex.Index()</c> only knows the binary, so without a session-load sweep the
/// record would answer at Effective during the session that created it and then silently vanish from
/// the next session's read model while compile (which assembles from source files on disk) still
/// emits it. Reloads the same mod folder in a brand-new <see cref="SessionManager"/> — the honest way
/// to prove "survives a restart" rather than asserting anything about the first session's own state.
/// </summary>
public sealed class WorkingTreeCreateRediscoveryTests
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

        // The rival: a sweep that inserts the row but forgets winner resweep (or runs before the
        // whole-session UpdateWinners() at the end of the load loop) leaves it_winner false.
        Assert.True(reloaded.Index!.GetDocument(created.NewFormKey!)!.IsWinner);
    }
}
