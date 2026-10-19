using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsNewTests
{
    [Fact]
    public void CopyRecordAsNewRecord_AllocatesAFreeFormKey_AndLandsAsAWorkingTreeRecordInTheDestination()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var newFormKey = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mod.DestinationPlugin);

        Assert.NotEqual(mod.SourceNpc.ToString(), newFormKey);
        Assert.EndsWith(":" + CopyFixture.DestinationPluginName, newFormKey, StringComparison.Ordinal);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE001", document.EditorId);

        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    [Fact]
    public void CopyRecordAsNewRecord_DerivesTheCopysEditorID_InTheCreationKitsShape()
    {
        using var mod = CopyFixture.Create();

        var newFormKey = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mod.DestinationPlugin);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.NotEqual(CopyFixture.SourceNpcEditorId, document.EditorId);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE001", document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_TwoCopiesOfOneRecordIntoOneDestination_GetDistinctEditorIDs()
    {
        using var mod = CopyFixture.Create();

        var first = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mod.DestinationPlugin);
        var second = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mod.DestinationPlugin);

        var firstFormKey = first;
        var secondFormKey = second;
        var firstDocument = mod.Document(mod.DestinationPlugin, firstFormKey);
        var secondDocument = mod.Document(mod.DestinationPlugin, secondFormKey);
        Assert.NotNull(firstDocument);
        Assert.NotNull(secondDocument);
        Assert.NotEqual(firstDocument.EditorId, secondDocument.EditorId);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE001", firstDocument.EditorId);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE002", secondDocument.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WhenTheDestinationAlreadyHoldsTheDerivedName_SkipsToTheNextCounter()
    {
        using var mod = CopyFixture.Create();
        Assert.True(mod.EditHandler.Set(
            mod.DestinationPlugin, mod.DestinationNpc.ToString(), "EditorID",
            JsonDocument.Parse("\"SourceNpcDUPLICATE001\"").RootElement).Applied);

        var newFormKey = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mod.DestinationPlugin);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE002", document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WhenTheDestinationHoldsACaseVariantOfTheDerivedName_StillCounts()
    {
        using var mod = CopyFixture.Create();
        Assert.True(mod.EditHandler.Set(
            mod.DestinationPlugin, mod.DestinationNpc.ToString(), "EditorID",
            JsonDocument.Parse("\"SOURCENPCDUPLICATE001\"").RootElement).Applied);

        var newFormKey = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mod.DestinationPlugin);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE002", document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WhenTheSourceHasNoEditorID_TheCopyHasNone()
    {
        using var mod = CopyFixture.Create();

        var newFormKey = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpcWithNoEditorId.ToString()), mod.DestinationPlugin);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Null(document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_RemapsASelfReference_OntoTheNewFormKey_NotTheOriginal()
    {
        using var mod = CopyFixture.Create();

        var newFormKey = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SelfLinkingFaction.ToString()), mod.DestinationPlugin);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Contains(newFormKey, document.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(mod.SelfLinkingFaction.ToString(), document.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = CopyFixture.Create();
        SourceModTree.SetNextObjectId(mod.ModFolderOf(mod.DestinationPlugin), mod.DestinationPlugin, 0xFFFFFF);
        SourceModTree.Seed(mod.ModFolderOf(mod.DestinationPlugin), mod.DestinationPlugin, "FFFFFF:Destination.esp");

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);
        var refused = result.OnlyRefused();

        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, refused.Refusal);
        Assert.Equal("Destination.esp has no FormKey free at or above its Next Object ID, up to 0xFFFFFF.", refused.Message);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsACell_PermanentlyDisallowed()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.InteriorCell.ToString())], CopyMode.New, [fixture.DestinationPlugin], replace: false);
        var refused = result.OnlyRefused();

        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, refused.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsAWorldspace_PermanentlyDisallowed()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Worldspace.ToString())], CopyMode.New, [fixture.DestinationPlugin], replace: false);
        var refused = result.OnlyRefused();

        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, refused.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_OnAQuestFromACompiledPluginSource_Succeeds()
    {
        using var fixture = ContainerCopyFixture.CreateWithCompiledPluginSource();

        var newFormKey = fixture.ScriptCopyHandler.CopyAsNew(new RecordAt(fixture.SourcePlugin, fixture.Quest.ToString()), fixture.DestinationPlugin);

        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, newFormKey));
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, "ABCDEF:Source.esm")], CopyMode.New, [mod.DestinationPlugin], replace: false);
        var refused = result.OnlyRefused();

        Assert.Equal(RecordEditRefusal.RecordNotFound, refused.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_MovesTheDestinationsNextObjectIdPastTheCopysFormKey()
    {
        using var mod = CopyFixture.Create();

        var result = mod.ScriptCopyHandler.CopyAsNew(new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString()), mod.DestinationPlugin);

        Assert.Equal("000801:Destination.esp", result);
        Assert.Equal(0x802u, mod.NextObjectId(mod.DestinationPlugin));
    }
}
