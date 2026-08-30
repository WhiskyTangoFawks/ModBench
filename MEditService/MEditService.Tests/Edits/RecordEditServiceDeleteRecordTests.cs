using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #427: delete-record, the user-facing gesture over the null-Body mechanism #415 already landed and
/// tested at the index layer (<c>WorkingTreeDeletionTests</c>). This suite is about the entry point's
/// own contract — the source file, and the two refusals every gesture on this write path must
/// inherit (#417's carried requirement) — not about winner/reference derivation, which is already
/// covered where the mechanism itself lives.
/// </summary>
public sealed class RecordEditServiceDeleteRecordTests
{
    private static RecordEditService ServiceFor(ISessionManager sessions) =>
        new(sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void DeleteRecord_RemovesTheSourceFile_GoneAtEffective_StillAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Sessions).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(mod.NpcSourceFile));
        Assert.Null(mod.Sessions.Index!.GetDocument(mod.Npc.ToString(), mod.Plugin));
        Assert.NotNull(mod.Sessions.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin));
    }

    /// <summary>
    /// #573: <see cref="RecordEditService.DeleteRecord"/> shares the exact
    /// <c>DuckDbRecordIndex.ApplyOneWorkingTreeChange</c> guard renumber's stale-index bug lived in —
    /// a record that never reached Head (still working-tree-only, straight off
    /// <see cref="RecordEditService.CreateRecord"/>) was silently kept at Effective by a guard that
    /// only ever checked Head for "does any ref know this record". The production fix (checking
    /// Effective too) covers this sibling for free; this is the regression that would have caught it.
    /// </summary>
    [Fact]
    public void DeleteRecord_OnANeverCommittedRecord_ActuallyRemovesItFromTheIndex()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Sessions);
        var created = service.CreateRecord(mod.Plugin, "npc_", "BrandNew");
        Assert.True(created.Applied, created.Message);

        var result = service.DeleteRecord(mod.Plugin, created.NewFormKey!);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Sessions.Index!.GetDocument(created.NewFormKey!, mod.Plugin));
        Assert.Null(mod.Sessions.Index!.At(RecordRef.Head).GetDocument(created.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void DeleteRecord_LeavesOtherRecordsUntouched()
    {
        using var mod = TrackedModFixture.Tracked();

        ServiceFor(mod.Sessions).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.NotNull(mod.Sessions.Index!.GetDocument(mod.OtherNpc.ToString(), mod.Plugin));
    }

    [Fact]
    public void DeleteRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = TrackedModFixture.Untracked();

        var result = ServiceFor(mod.Sessions).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecord_Refuses_WhileAnExternalChangeQuestionIsPending()
    {
        using var mod = TrackedModFixture.Tracked();
        ExternalChangeDeferral.Set(mod.ModFolder, TrackedModFixture.PluginName, "pending");

        var result = ServiceFor(mod.Sessions).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangePending, result.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile)); // refused before the first door — nothing written
    }

    [Fact]
    public void DeleteRecord_Refuses_ForAnUnknownFormKey()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Sessions).DeleteRecord(mod.Plugin, "FFFFFF:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
