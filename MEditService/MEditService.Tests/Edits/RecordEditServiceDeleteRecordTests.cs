using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

public sealed class RecordEditServiceDeleteRecordTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

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
