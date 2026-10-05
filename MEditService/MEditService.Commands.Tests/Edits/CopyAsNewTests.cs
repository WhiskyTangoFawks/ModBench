using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsNewTests
{
    [Fact]
    public void CopyRecordAsNewRecord_AllocatesAFreeFormKey_AndLandsAsAWorkingTreeRecordInTheDestination()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var newFormKey = result.NewFormKey;
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

        var result = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var document = mod.Document(mod.DestinationPlugin, result.NewFormKey);
        Assert.NotNull(document);
        Assert.NotEqual(CopyFixture.SourceNpcEditorId, document.EditorId);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE001", document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_TwoCopiesOfOneRecordIntoOneDestination_GetDistinctEditorIDs()
    {
        using var mod = CopyFixture.Create();

        var first = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);
        var second = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(first.Applied, first.Message);
        Assert.True(second.Applied, second.Message);
        Assert.NotNull(first.NewFormKey);
        Assert.NotNull(second.NewFormKey);
        var firstDocument = mod.Document(mod.DestinationPlugin, first.NewFormKey);
        var secondDocument = mod.Document(mod.DestinationPlugin, second.NewFormKey);
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

        var result = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var document = mod.Document(mod.DestinationPlugin, result.NewFormKey);
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

        var result = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var document = mod.Document(mod.DestinationPlugin, result.NewFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE002", document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WhenTheSourceHasNoEditorID_TheCopyHasNone()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopyAsNew(
            mod.SourcePlugin, mod.SourceNpcWithNoEditorId.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        var document = mod.Document(mod.DestinationPlugin, result.NewFormKey);
        Assert.NotNull(document);
        Assert.Null(document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_RemapsASelfReference_OntoTheNewFormKey_NotTheOriginal()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopyAsNew(
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
    public void CopyRecordAsNewRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = CopyFixture.Create();
        TrackedTree.Seed(mod.ModFolderOf(mod.DestinationPlugin), mod.DestinationPlugin, "FFFFFF:Destination.esp");

        var result = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
        Assert.Contains("Clear the light flag", result.Message, StringComparison.Ordinal);
        Assert.Contains("change a record's FormID", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsACell_PermanentlyDisallowed()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsNew(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsAWorldspace_PermanentlyDisallowed()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsNew(
            fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_OnAQuestFromATrackedSource_Succeeds()
    {
        using var fixture = ContainerCopyFixture.CreateWithTrackedSource();

        var result = fixture.CopyHandler.CopyAsNew(
            fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, result.NewFormKey));
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopyAsNew(mod.SourcePlugin, "ABCDEF:Source.esm", mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
