using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsNewTests
{
    [Fact]
    public void CopyRecordAsNewRecord_AllocatesAFreeFormKey_AndLandsAsAWorkingTreeRecordInTheDestination()
    {
        using var mod = CopyFixture.Create();
        var sourceBefore = mod.SourcePluginBytes();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.NotEqual(mod.SourceNpc.ToString(), newFormKey);
        Assert.EndsWith(":" + CopyFixture.DestinationPluginName, newFormKey, StringComparison.Ordinal);

        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE001", document.EditorId);

        Assert.Equal(sourceBefore, mod.SourcePluginBytes());
    }

    [Fact]
    public void CopyRecordAsNewRecord_TwoCopiesOfOneRecordIntoOneDestination_GetDistinctEditorIDs()
    {
        using var mod = CopyFixture.Create();

        var first = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);
        var second = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var firstFormKey = first.OnlyLanded().Require();
        var secondFormKey = second.OnlyLanded().Require();
        var firstDocument = mod.Document(mod.DestinationPlugin, firstFormKey);
        var secondDocument = mod.Document(mod.DestinationPlugin, secondFormKey);
        Assert.NotNull(firstDocument);
        Assert.NotNull(secondDocument);
        Assert.NotEqual(firstDocument.EditorId, secondDocument.EditorId);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE001", firstDocument.EditorId);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE002", secondDocument.EditorId);
    }

    [Theory]
    [InlineData("SourceNpcDUPLICATE001")]
    [InlineData("SOURCENPCDUPLICATE001")]
    public void CopyRecordAsNewRecord_WhenTheDestinationAlreadyHoldsTheDerivedName_InAnyCase_SkipsToTheNextCounter(string held)
    {
        using var mod = CopyFixture.Create();
        Assert.True(mod.EditHandler.Set(
            mod.DestinationPlugin, mod.DestinationNpc.ToString(), "EditorID",
            JsonDocument.Parse($"\"{held}\"").RootElement).Applied);

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(CopyFixture.SourceNpcEditorId + "DUPLICATE002", document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WhenTheSourceHasNoEditorID_TheCopyHasNone()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpcWithNoEditorId.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        var document = mod.Document(mod.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Null(document.EditorId);
    }

    [Fact]
    public void CopyRecordAsNewRecord_RemapsASelfReference_OntoTheNewFormKey_NotTheOriginal()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SelfLinkingFaction.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
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

    public static TheoryData<string, Func<ContainerCopyFixture, FormKey>> CellsAndWorldspaces => new()
    {
        { "a cell", fixture => fixture.InteriorCell },
        { "a worldspace", fixture => fixture.Worldspace },
    };

    [Theory]
    [MemberData(nameof(CellsAndWorldspaces))]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsACellOrAWorldspace_PermanentlyDisallowed(string _, Func<ContainerCopyFixture, FormKey> source)
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, source(fixture).ToString())], CopyMode.New, [fixture.DestinationPlugin], replace: false);
        var refused = result.OnlyRefused();

        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, refused.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_OnAQuestFromACompiledPluginSource_Succeeds()
    {
        using var fixture = ContainerCopyFixture.CreateWithCompiledPluginSource();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Quest.ToString())], CopyMode.New, [fixture.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, newFormKey));
    }

    [Fact]
    public void CopyRecordAsNewRecord_MovesTheDestinationsNextObjectIdPastTheCopysFormKey()
    {
        using var mod = CopyFixture.Create();

        var result = mod.CopyHandler.CopySync([new RecordAt(mod.SourcePlugin, mod.SourceNpc.ToString())], CopyMode.New, [mod.DestinationPlugin], replace: false);

        Assert.Equal("000801:Destination.esp", result.OnlyLanded());
        Assert.Equal(0x802u, mod.NextObjectId(mod.DestinationPlugin));
    }
}
