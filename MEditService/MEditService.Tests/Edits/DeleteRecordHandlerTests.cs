using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

public sealed class DeleteRecordHandlerTests
{
    [Fact]
    public void DeleteRecord_OnTheHeader_RefusesWithoutTouchingTheSourceTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var result = mod.DeleteHandler.DeleteRecord(mod.Plugin, headerFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.HeaderDeleteOrRenumberNotSupported, result.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile), "an unrelated sibling record's file must survive");
        Assert.True(
            Directory.Exists(Path.Combine(mod.ModFolder, "source", mod.ActualPluginName)),
            "the plugin's own tracked source tree must survive");
        Assert.NotNull(mod.Document(headerFormKey));
    }

    [Fact]
    public void DeleteRecord_RemovesTheSourceFile_GoneFromTheTree_StillAtHead()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(mod.NpcSourceFile));
        Assert.Null(mod.Document(mod.Npc.ToString()));
        // Still served by the last commit until a compile: a working-tree deletion is not a compile.
        Assert.NotNull(
            mod.CommittedDocument(mod.Npc.ToString(), "npc_", SourceEditFixture.NpcEditorId));
    }

    [Fact]
    public void DeleteRecord_OnANeverCommittedRecord_LeavesNothingAtEitherRef()
    {
        using var mod = SourceEditFixture.Tracked();
        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNew");
        Assert.True(created.Applied, created.Message);

        var result = mod.DeleteHandler.DeleteRecord(mod.Plugin, created.NewFormKey!);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Document(created.NewFormKey!));
        Assert.Null(mod.CommittedDocument(created.NewFormKey!, "npc_", "BrandNew"));
    }

    [Fact]
    public void DeleteRecord_LeavesOtherRecordsUntouched()
    {
        using var mod = SourceEditFixture.Tracked();

        mod.DeleteHandler.DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.NotNull(mod.Document(mod.OtherNpc.ToString()));
    }

    [Fact]
    public void DeleteRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.DeleteHandler.DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecord_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = SourceEditFixture.Tracked();
        ExternalChangeDeferral.Set(mod.ModFolder, "unanswered");

        var result = mod.DeleteHandler.DeleteRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile)); // refused before the first door — nothing written
    }

    [Fact]
    public void DeleteRecord_Refuses_ForAnUnknownFormKey()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecord(mod.Plugin, "FFFFFF:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
