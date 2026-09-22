using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceRepo;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyRecordAsNewRecordHandlerTests
{
    [Fact]
    public void CopyRecordAsNewRecord_AllocatesAFreeFormKey_AndLandsAsAWorkingTreeRecordInTheDestination()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var newFormKey = result.NewFormKey;
        Assert.NotEqual(mod.SourceNpc.ToString(), newFormKey);
        Assert.EndsWith(":" + CopyFixture.DestinationPluginName, newFormKey, StringComparison.Ordinal);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId, document.EditorId);

        // The source plugin's own file is untouched — this is a copy, not a move.
        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    [Fact]
    public void CopyRecordAsNewRecord_WithARequestedFormKey_UsesItExactly()
    {
        using var mod = CopyFixture.Create();
        const string requested = "900000:Destination.esp";

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    [Fact]
    public void CopyRecordAsNewRecord_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var newFormKey = result.NewFormKey;
        Assert.Null(mod.CommittedDocument(
            mod.DestinationPlugin,
            new RecordIdentity(newFormKey, "npc_", CopyFixture.SourceNpcEditorId)));
    }

    // "Internal self-references follow the duplicate, not the
    // original" — RemapLinks fired right after Duplicate, on a record whose own FormLink field can
    // validly target its own record type (a Faction related to itself).
    [Fact]
    public void CopyRecordAsNewRecord_RemapsASelfReference_OntoTheNewFormKey_NotTheOriginal()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SelfLinkingFaction.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var newFormKey = result.NewFormKey;
        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Contains(newFormKey, document.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(mod.SelfLinkingFaction.ToString(), document.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheDestinationIsUntracked_NamingTheTrackCommand()
    {
        using var mod = CopyFixture.Create();
        Directory.Delete(Path.Combine(mod.DestinationModFolder, ".git"), recursive: true);

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WithARequestedFormKey_Refuses_WhenItCollides()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, mod.DestinationNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WithARequestedFormKey_Refuses_WhenItBelongsToADifferentPlugin()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = CopyFixture.Create();
        var seeded = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, "FFFFFF:Destination.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    // A Cell is on xEdit's own permanent blacklist (CELL/WRLD/LAND/NAVM/PGRD/ROAD/NAVI) —
    // refused forever, not "not yet built" — distinct from the Quest/DialogTopic/INFO family below.
    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsACell_PermanentlyDisallowed()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsNewHandler.CopyRecordAsNewRecord(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsAWorldspace_PermanentlyDisallowed()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsNewHandler.CopyRecordAsNewRecord(
            fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, result.Refusal);
    }

    // A Quest is not on xEdit's permanent blacklist: DIAL/INFO/QUST copy as new. From a tracked
    // source, so the record's text comes out of a working tree rather than a plugin file.
    [Fact]
    public void CopyRecordAsNewRecord_OnAQuestFromATrackedSource_Succeeds()
    {
        using var fixture = ContainerCopyFixture.CreateWithTrackedSource();

        var result = fixture.CopyAsNewHandler.CopyRecordAsNewRecord(
            fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, result.NewFormKey));
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(mod.SourcePlugin, "ABCDEF:Source.esm", mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
