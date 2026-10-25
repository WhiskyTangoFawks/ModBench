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
    public void ADeleteOfSeveralRecords_LandsEach_AndRefusesTheHeaderWithItsReason()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var header = new RecordAt(mod.Plugin, PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName)));
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());

        var result = mod.DeleteHandler.DeleteRecordsSync([npc, header, otherNpc]);

        Assert.Equal([npc, otherNpc], result.Applied.Select(applied => applied.Record));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(header, refused.Item);
        Assert.Equal(RecordEditRefusal.HeaderDeleteNotSupported, refused.Refusal);
        Assert.False(string.IsNullOrWhiteSpace(refused.Message));
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.Null(mod.Document(mod.OtherNpc.ToString()));
        Assert.NotNull(mod.Document(header.FormKey));
    }

    [Fact]
    public void ADeleteNamingOneRecordTwice_DeletesItOnce_AndRefusesNothing()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());

        var npcSpelledOtherwise = new RecordAt(
            new PluginAddress(mod.Plugin.Name.ToUpperInvariant(), mod.Plugin.Origin.ToLowerInvariant()),
            mod.Npc.ToString().ToLowerInvariant());

        var result = mod.DeleteHandler.DeleteRecordsSync([npc, otherNpc, npc, npcSpelledOtherwise]);

        Assert.Equal([npc, otherNpc], result.Applied.Select(applied => applied.Record));
        Assert.Empty(result.Refused);
    }

    [Fact]
    public void ADeleteOfARecordAnotherToolLeftTwoDocumentsClaiming_RefusesThatRecord_AndLandsTheRest()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        TreeTampering.Duplicate(mod.ModFolder, mod.Plugin, mod.NpcIdentity);
        var otherNpc = new RecordAt(mod.Plugin, mod.OtherNpc.ToString());
        var npc = new RecordAt(mod.Plugin, mod.Npc.ToString());
        var keyword = new RecordAt(mod.Plugin, mod.Keyword.ToString());

        var result = mod.DeleteHandler.DeleteRecordsSync([otherNpc, npc, keyword]);

        Assert.Equal([otherNpc, keyword], result.Applied.Select(applied => applied.Record));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(npc, refused.Item);
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, refused.Refusal);
        Assert.Contains(mod.Npc.ToString(), refused.Message, StringComparison.Ordinal);
        Assert.IsType<SourceFailure.Ambiguous>(SourceModTree.Repository(mod.ModFolder, mod.Plugin).RecordByFormKey(mod.Plugin, mod.Npc.ToString()).Stopped());
    }

    [Fact]
    public void TheChangesOfADelete_AnswerTheRecordsFileAsADeletion_AndWriteNothing()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.DeleteHandler.DeleteChangesSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        var deletion = Assert.Single(Assert.Single(result.Applied).Deletions);
        Assert.Equal(TreeTampering.FileOf(mod.ModFolder, mod.Plugin, mod.NpcIdentity), deletion);
        Assert.True(File.Exists(deletion));
        Assert.NotNull(mod.Document(mod.Npc.ToString()));
    }

    [Fact]
    public void TheChangesOfDeletingAnEmbeddedChild_RewriteItsOwnersUnsavedText()
    {
        using var fixture = new ContainerModFixture();
        var owner = fixture.DocumentCarrying(ContainerModPlugin.EmbedCellEditorId);
        var unsaved = new DocumentChange(
            TreeTampering.FileOf(fixture.ModFolder, fixture.Plugin, owner.Identity), owner.Body.Replace(ContainerModPlugin.NavmeshEditorId, "UnsavedNavmesh", StringComparison.Ordinal));

        fixture.Unsaved.Apply([unsaved]);

        var result = fixture.DeleteHandler.DeleteChangesSync([new RecordAt(fixture.Plugin, fixture.TemporaryRef.ToString())]);

        var document = Assert.Single(Assert.Single(result.Applied).Documents);
        Assert.Contains("UnsavedNavmesh", document.Text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerModPlugin.TemporaryRefEditorId, document.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void TheChangesOfDeletingARecordWhoseUnsavedTextGivesItAnotherFormKey_DeleteItsFileUnderThatKey()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var npc = SourceModTree.DocumentCarrying(mod.ModFolder, mod.Plugin, SourceEditFixture.NpcEditorId);
        var retyped = $"000F00:{mod.Plugin.Name}";
        var file = TreeTampering.FileOf(mod.ModFolder, mod.Plugin, mod.NpcIdentity);
        mod.Unsaved.Apply([new DocumentChange(file, npc.Body.Replace(mod.Npc.ToString(), retyped, StringComparison.Ordinal))]);

        var result = mod.DeleteHandler.DeleteChangesSync([new RecordAt(mod.Plugin, retyped)]);

        Assert.Equal(file, Assert.Single(Assert.Single(result.Applied).Deletions));
    }

    [Fact]
    public void ADeleteOfTwoChildrenOfOneContainer_LeavesTheContainerWithNeither()
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
    public void ADelete_LeavesOtherRecordsUntouched()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        Assert.NotNull(mod.Document(mod.OtherNpc.ToString()));
    }

    [Fact]
    public void ADeleteInANonCompiledPlugin_IsRefusedAsPluginNotCompiledPlugin()
    {
        using var mod = SourceEditFixture.NonCompiledPlugin();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, mod.Npc.ToString())]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.PluginNotCompiledPlugin, refused.Refusal);
    }

    [Fact]
    public void ADeleteOfAFormKeyNoDocumentHolds_IsRefusedAsRecordNotFound()
    {
        using var mod = SourceEditFixture.CompiledPlugin();

        var result = mod.DeleteHandler.DeleteRecordsSync([new RecordAt(mod.Plugin, "FFFFFF:Fixture.esp")]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
    }
}
