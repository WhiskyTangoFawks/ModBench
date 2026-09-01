using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// Delete-record, the user-facing gesture over the null-Body mechanism
/// tested at the index layer (<c>WorkingTreeDeletionTests</c>). This suite is about the entry point's
/// own contract — the source file, and the two refusals every gesture on this write path must
/// inherit — not about winner/reference derivation, which is already
/// covered where the mechanism itself lives.
/// </summary>
public sealed class RecordEditServiceDeleteRecordTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    /// <summary>
    /// #661 regression: <c>SourceUnitResolver</c> now resolves the header's own root
    /// <c>RecordData.json</c> — but <c>SourceUnit.IsDirectoryPerRecord</c> tells "container's own file"
    /// from "flat record" by filename alone (<c>RecordData.json</c>), and cannot tell the header's copy
    /// of that name, which sits <i>at</i> the plugin's own source root, from a container's, which sits
    /// one level <i>under</i> it. Left unguarded, <see cref="RecordEditService.DeleteRecord"/> answered
    /// true for the header and deleted the plugin's <i>entire</i> tracked source tree as "one record's"
    /// delete — found in review, reproduced, and this is the regression test: a sibling record's file
    /// surviving is exactly the assertion that would have caught it.
    /// </summary>
    [Fact]
    public void DeleteRecord_OnTheHeader_RefusesWithoutTouchingTheSourceTree()
    {
        using var mod = TrackedModFixture.Tracked();
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var result = ServiceFor(mod.Mirror).DeleteRecord(mod.Plugin, headerFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.HeaderDeleteOrRenumberNotSupported, result.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile), "an unrelated sibling record's file must survive");
        Assert.True(
            Directory.Exists(Path.Combine(mod.ModFolder, "source", mod.ActualPluginName)),
            "the plugin's own tracked source tree must survive");
        Assert.NotNull(mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, mod.Plugin));
    }

    [Fact]
    public void DeleteRecord_RemovesTheSourceFile_GoneAtEffective_StillAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(mod.NpcSourceFile));
        Assert.Null(mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin));
        Assert.NotNull(mod.Mirror.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin));
    }

    /// <summary>
    /// <see cref="RecordEditService.DeleteRecord"/> shares the
    /// <c>DuckDbRecordIndex.ApplyOneWorkingTreeChange</c> guard —
    /// a record that never reached Head (still working-tree-only, straight off
    /// <see cref="RecordEditService.CreateRecord"/>) is silently kept at Effective by a guard that
    /// only ever checks Head for "does any ref know this record"; the guard must check
    /// Effective too. This is the regression test for that.
    /// </summary>
    [Fact]
    public void DeleteRecord_OnANeverCommittedRecord_ActuallyRemovesItFromTheIndex()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);
        var created = service.CreateRecord(mod.Plugin, "npc_", "BrandNew");
        Assert.True(created.Applied, created.Message);

        var result = service.DeleteRecord(mod.Plugin, created.NewFormKey!);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(created.NewFormKey!, mod.Plugin));
        Assert.Null(mod.Mirror.Index!.At(RecordRef.Head).GetDocument(created.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void DeleteRecord_LeavesOtherRecordsUntouched()
    {
        using var mod = TrackedModFixture.Tracked();

        ServiceFor(mod.Mirror).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.NotNull(mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(mod.OtherNpc.ToString(), mod.Plugin));
    }

    [Fact]
    public void DeleteRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = TrackedModFixture.Untracked();

        var result = ServiceFor(mod.Mirror).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecord_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = TrackedModFixture.Tracked();
        ExternalChangeDeferral.Set(mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        var result = ServiceFor(mod.Mirror).DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile)); // refused before the first door — nothing written
    }

    [Fact]
    public void DeleteRecord_Refuses_ForAnUnknownFormKey()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).DeleteRecord(mod.Plugin, "FFFFFF:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
