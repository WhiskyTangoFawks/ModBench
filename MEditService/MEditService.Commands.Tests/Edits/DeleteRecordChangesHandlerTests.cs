using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class DeleteRecordChangesHandlerTests
{
    [Fact]
    public void DeleteRecords_LandsEachRecordOnItsOwn_AndRefusesTheOneThatCannotWithItsReason()
    {
        using var mod = SourceEditFixture.Tracked();
        var header = new RecordAt(mod.Plugin, PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName)));
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());

        var result = mod.DeleteHandler.DeleteRecordsSync([npc, header, otherNpc]);

        Assert.Equal([npc, otherNpc], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(header, refused.Item);
        Assert.Equal(RecordEditRefusal.HeaderDeleteNotSupported, refused.Refusal);
        Assert.False(string.IsNullOrWhiteSpace(refused.Message));
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.Null(mod.Document(mod.OtherNpc.ToString()));
        Assert.NotNull(mod.Document(header.FormKey));
    }

    [Fact]
    public void DeleteRecords_NamingOneRecordTwice_DeletesItOnce_AndRefusesNothing()
    {
        using var mod = SourceEditFixture.Tracked();
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());

        var npcSpelledOtherwise = new RecordAt(
            new PluginAddress(mod.Plugin.Name.ToUpperInvariant(), mod.Plugin.Origin.ToLowerInvariant()),
            mod.Npc.ToString().ToLowerInvariant());

        var result = mod.DeleteHandler.DeleteRecordsSync([npc, otherNpc, npc, npcSpelledOtherwise]);

        Assert.Equal([npc, otherNpc], result.Landed.Select(landed => landed.Item));
        Assert.Empty(result.Refused);
    }

    [Fact]
    public void DeleteRecords_WhenAnotherToolLeftTwoDocumentsClaimingOneRecord_RefusesThatRecord_AndLandsTheRest()
    {
        using var mod = SourceEditFixture.Tracked();
        TreeTampering.Duplicate(mod.ModFolder, mod.Plugin, mod.NpcIdentity);
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var keyword = new RecordAt(mod.Plugin, mod.Keyword.ToString());

        var result = mod.DeleteHandler.DeleteRecordsSync([otherNpc, npc, keyword]);

        Assert.Equal([otherNpc, keyword], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(npc, refused.Item);
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, refused.Refusal);
        Assert.Contains(mod.Npc.ToString(), refused.Message, StringComparison.Ordinal);
        Assert.IsType<SourceFailure.Ambiguous>(TrackedTree.Repository(mod.ModFolder, mod.Plugin).Get(mod.Plugin, mod.Npc.ToString()).Stopped());
    }

    [Fact]
    public void DeleteChanges_AnswerTheRecordsFileAsADeletion_AndWriteNothing()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteChangesSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        var deletion = Assert.Single(Assert.Single(result.Landed).Outcome.Deletions);
        Assert.True(Path.IsPathRooted(deletion));
        Assert.True(File.Exists(deletion) || Directory.Exists(deletion));
        Assert.NotNull(mod.Document(mod.Npc.ToString()));
    }

    [Fact]
    public void DeleteChanges_OfAnEmbeddedChild_RewriteItsOwnersUnsavedText()
    {
        using var fixture = new ContainerModFixture();
        var owner = fixture.DocumentCarrying(ContainerModPlugin.EmbedCellEditorId);
        var unsaved = new DocumentChange(
            TreeTampering.FileOf(fixture.ModFolder, fixture.Plugin, owner.Identity), owner.Body.Replace(ContainerModPlugin.NavmeshEditorId, "UnsavedNavmesh", StringComparison.Ordinal));

        var result = fixture.DeleteHandler.DeleteChangesSync([new RecordAt(fixture.Plugin, fixture.TemporaryRef.ToString())], [unsaved]);

        var document = Assert.Single(Assert.Single(result.Landed).Outcome.Documents);
        Assert.Contains("UnsavedNavmesh", document.Text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerModPlugin.TemporaryRefEditorId, document.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecords_OfTwoChildrenOfOneContainer_LeavesTheContainerWithNeitherOnceTheItemsAreMadeInOrder()
    {
        using var fixture = new ContainerModFixture();

        var result = fixture.DeleteHandler.DeleteRecordsSync(
            [new RecordAt(fixture.Plugin, fixture.TemporaryRef.ToString()), new RecordAt(fixture.Plugin, fixture.PersistentRef.ToString())]);

        Assert.Empty(result.Refused);
        var owner = fixture.DocumentCarrying(ContainerModPlugin.EmbedCellEditorId).Body;
        Assert.DoesNotContain(ContainerModPlugin.TemporaryRefEditorId, owner, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerModPlugin.PersistentRefEditorId, owner, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.NavmeshEditorId, owner, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecords_OnTheHeader_RefusesWithoutTouchingTheSourceTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, headerFormKey)]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.HeaderDeleteNotSupported, refused.Refusal);
        Assert.NotNull(mod.Document(mod.Npc.ToString()));
        Assert.NotNull(mod.Document(headerFormKey));
    }

    [Fact]
    public void DeleteRecords_RemovesTheRecordFromTheTree()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.Empty(result.Refused);
        Assert.Null(mod.Document(mod.Npc.ToString()));
    }

    [Fact]
    public void DeleteRecords_LeavesOtherRecordsUntouched()
    {
        using var mod = SourceEditFixture.Tracked();

        mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.NotNull(mod.Document(mod.OtherNpc.ToString()));
    }

    [Fact]
    public void DeleteRecords_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, refused.Refusal);
        Assert.Contains("Track its mod", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteRecords_Refuses_ForAnUnknownFormKey()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, "FFFFFF:Fixture.esp")]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
    }
}
