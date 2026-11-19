using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsOverrideContainerTests
{
    [Fact]
    public void CopyRecordAsOverride_OfAPersistentCellIntoAWorldspaceWhosePersistentCellIsAnother_IsRefusedAsASlotHeldByAnotherRecordAndWritesNothing()
    {
        using var fixture = ContainerCopyFixture.Create();
        fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Worldspace.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false).OnlyLanded();
        SourceEdits.Rewrite<Worldspace>(
            SourceModTree.Repository(fixture.DestinationModFolder, fixture.DestinationPlugin), fixture.DestinationPlugin,
            new RecordIdentity(fixture.Worldspace.ToString(), "wrld", ContainerCopyFixture.WorldspaceEditorId),
            GameRelease.Fallout4,
            worldspace => worldspace.TopCell = new Cell(FormKey.Factory($"0ABCDE:{ContainerCopyFixture.DestinationPluginName}"), Fallout4Release.Fallout4));
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.TopCell.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, refused.Refusal);
        Assert.Contains("holds another record where the copy puts one", refused.Message, StringComparison.Ordinal);
        Assert.Contains(ContainerCopyFixture.DestinationPluginName, refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.DestinationModFolder));
    }

    [Fact]
    public void CopyRecordAsOverride_OfAnExteriorCellSelectedBeforeItsWorldspace_LandsBoth_WorldspaceFirst()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync(
            [new RecordAt(fixture.SourcePlugin, fixture.ExteriorCell.ToString()), new RecordAt(fixture.SourcePlugin, fixture.Worldspace.ToString())],
            CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        Assert.Empty(result.Refused);
        Assert.Equal(2, result.Applied.Count);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()));
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString()));
    }

    [Fact]
    public void CopyRecordAsOverride_OfAChildSelectedBeforeItsContainer_LandsBoth_ContainerFirst()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync(
            [new RecordAt(fixture.SourcePlugin, fixture.DialogTopic.ToString()), new RecordAt(fixture.SourcePlugin, fixture.Quest.ToString())],
            CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        Assert.Empty(result.Refused);
        Assert.Equal(2, result.Applied.Count);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()));
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString()));
    }

    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorCell_Succeeds_OwnFieldsLand_EmbeddedSlotsEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.InteriorCell.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

        var document = fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString());
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.InteriorCellEditorId, document.EditorId);
        Assert.Contains(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}",
            fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.InteriorCellEditorId).Body,
            StringComparison.Ordinal);

        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TemporaryRef.ToString()));

        var text = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.InteriorCellEditorId).Body;
        Assert.DoesNotContain(ContainerCopyFixture.PersistentRefEditorId, text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.NavmeshEditorId, text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.LandscapeEditorId, text, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_OnAPlacedReference_WhenDestinationAlreadyOverridesTheCell_AppendsWithoutPartialFormingTheCell()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = fixture.CopyHandler;
        service.CopySync([new RecordAt(fixture.SourcePlugin, fixture.InteriorCell.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(fixture.SourcePlugin, fixture.PersistentRef.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var child = fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString());
        Assert.NotNull(child);
        Assert.Equal(ContainerCopyFixture.PersistentRefEditorId, child.EditorId);

        var cellText = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.InteriorCellEditorId).Body;
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, cellText, StringComparison.Ordinal);

        Assert.False(fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString()).Require().IsPartialForm());
    }

    [Fact]
    public void CopyRecordAsOverride_OnATopCellPlacedReference_CopiesTheWorldspaceAndItsPersistentCellIn_WhenDestinationHasNeither()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.TopCellRef.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var worldspace = fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require();
        Assert.True(worldspace.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, worldspace.EditorId);

        var topCell = JsonNode.Parse(worldspace.Body).Require()["TopCell"].Require();
        Assert.Equal(fixture.TopCell.ToString(), topCell["FormKey"].Require().GetValue<string>());
        Assert.Equal(ContainerCopyFixture.TopCellEditorId, topCell["EditorID"].Require().GetValue<string>());
        Assert.False(topCell.AsObject().ContainsKey("MajorRecordFlagsRaw"));
        var placed = Assert.Single(topCell["Temporary"].Require().AsArray());
        Assert.Equal(fixture.TopCellRef.ToString(), placed.Require()["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void CopyRecordAsOverride_OnATopCellItself_CopiesItIntoTheWorldspaceItMintsWithItsFields_WithoutItsRecords()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.TopCell.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var worldspace = fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require();
        Assert.True(worldspace.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, worldspace.EditorId);

        var topCell = JsonNode.Parse(worldspace.Body).Require()["TopCell"].Require().AsObject();
        Assert.Equal(fixture.TopCell.ToString(), topCell["FormKey"].Require().GetValue<string>());
        Assert.Equal(ContainerCopyFixture.TopCellEditorId, topCell["EditorID"].Require().GetValue<string>());
        Assert.False(topCell.ContainsKey("Persistent"));
        Assert.False(topCell.ContainsKey("Temporary"));
    }

    [Fact]
    public void CopyRecordAsOverride_OnATopCellPlacedReferenceFromACompiledPluginSource_CopiesTheWorldspaceAndItsPersistentCellIn()
    {
        using var fixture = ContainerCopyFixture.CreateWithCompiledPluginSource();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.TopCellRef.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var worldspace = fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require();
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, worldspace.EditorId);
        var topCell = JsonNode.Parse(worldspace.Body).Require()["TopCell"].Require();
        Assert.Equal(ContainerCopyFixture.TopCellEditorId, topCell["EditorID"].Require().GetValue<string>());
        Assert.Equal(
            fixture.TopCellRef.ToString(),
            Assert.Single(topCell["Temporary"].Require().AsArray()).Require()["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void CopyRecordAsOverride_OnATopCell_WhenDestinationAlreadyOverridesTheWorldspace_LandsItInThatWorldspaceUntouchedOtherwise()
    {
        using var fixture = ContainerCopyFixture.Create();
        fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Worldspace.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false).OnlyLanded();
        var before = JsonNode.Parse(fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require().Body).Require().AsObject();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.TopCell.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var after = JsonNode.Parse(fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require().Body).Require().AsObject();
        Assert.Equal(
            fixture.TopCell.ToString(), after["TopCell"].Require()["FormKey"].Require().GetValue<string>());
        after.Remove("TopCell");
        Assert.Equal(before.ToJsonString(), after.ToJsonString());
    }

    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorPlacedReference_CopiesTheWorldspaceAndCellInWithTheirFields_WhenDestinationHasNeither()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

        var worldspace = fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require();
        Assert.True(worldspace.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, worldspace.EditorId);

        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.False(cell.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.ExteriorCellEditorId, cell.EditorId);

        var placed = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString());
        Assert.NotNull(placed);
        Assert.Equal(ContainerCopyFixture.ExteriorPersistentRefEditorId, placed.EditorId);

        var cellText = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.ExteriorPersistentRefEditorId).Body;
        Assert.Contains(ContainerCopyFixture.ExteriorPersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.ExteriorTemporaryRefEditorId, cellText, StringComparison.Ordinal);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));

        fixture.AssertDestinationCellSitsAt(
            fixture.ExteriorCell.ToString(), ContainerCopyFixture.ExteriorCellEditorId,
            ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY, ContainerCopyFixture.ExteriorSubX, ContainerCopyFixture.ExteriorSubY);
        Assert.Contains(
            $"\"{ContainerCopyFixture.ExteriorGridX}, {ContainerCopyFixture.ExteriorGridY}\"",
            cell.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_OnAnExteriorPlacedReferenceFromACompiledPluginSource_MintsAtTheSourcesOwnBlock()
    {
        using var fixture = ContainerCopyFixture.CreateWithCompiledPluginSource();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

        fixture.AssertDestinationCellSitsAt(
            fixture.ExteriorCell.ToString(), ContainerCopyFixture.ExteriorCellEditorId,
            ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY, ContainerCopyFixture.ExteriorSubX, ContainerCopyFixture.ExteriorSubY);
        Assert.Contains(
            ContainerCopyFixture.ExteriorPersistentRefEditorId,
            fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.ExteriorPersistentRefEditorId).Body,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorTemporaryPlacedReference_LandsInTheTemporarySlot()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.ExteriorTemporaryRef.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.False(cell.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.ExteriorCellEditorId, cell.EditorId);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString()));

        var slots = JsonDocument.Parse(cell.Body).RootElement;
        Assert.Equal(
            fixture.ExteriorTemporaryRef.ToString(),
            Assert.Single(slots.GetProperty("Temporary").EnumerateArray()).GetProperty("FormKey").GetString());
        Assert.False(slots.TryGetProperty("Persistent", out _));
    }

    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorCellItself_CopiesTheWorldspaceInWithItsFields_CellLandsOwnFieldsOnly()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.ExteriorCell.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

        var worldspace = fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require();
        Assert.True(worldspace.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, worldspace.EditorId);

        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.Equal(ContainerCopyFixture.ExteriorCellEditorId, cell.EditorId);
        Assert.False(cell.IsPartialForm());

        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));

        fixture.AssertDestinationCellSitsAt(
            fixture.ExteriorCell.ToString(), ContainerCopyFixture.ExteriorCellEditorId,
            ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY, ContainerCopyFixture.ExteriorSubX, ContainerCopyFixture.ExteriorSubY);
    }

    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorPlacedReference_CopiesTheCellInWithItsFields_WhenMissing()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.PersistentRef.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();

        var copiedCell = fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString());
        Assert.NotNull(copiedCell);
        Assert.False(copiedCell.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.InteriorCellEditorId, copiedCell.EditorId);

        var cellText = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.PersistentRefEditorId).Body;
        Assert.Contains(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}", cellText, StringComparison.Ordinal);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, cellText, StringComparison.Ordinal);

        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString()));
    }

    private static string DestinationFile(ContainerCopyFixture fixture, FormKey record) =>
        SourceModTree.DocumentFile(fixture.DestinationModFolder, fixture.DestinationPlugin, record.ToString()).Require();

    private static string FolderOf(ContainerCopyFixture fixture, FormKey container, string slot) =>
        Path.Combine(Path.GetDirectoryName(DestinationFile(fixture, container)).Require(), slot) + Path.DirectorySeparatorChar;

    [Fact]
    public void CopyRecordAsOverride_OnAResponse_WhenDestinationAlreadyHoldsItsTopic_LandsInItsOwnFile_WithTheQuestAndTopicUntouched()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = fixture.CopyHandler;
        service.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Response2.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false).OnlyLanded();
        var quest = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()).Require().Body;
        var topic = fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString()).Require().Body;

        var result = service.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Response1.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.StartsWith(FolderOf(fixture, fixture.DialogTopic, "Responses"), DestinationFile(fixture, fixture.Response1), StringComparison.Ordinal);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Response2.ToString()));
        Assert.Equal(quest, fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()).Require().Body);
        Assert.Equal(topic, fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString()).Require().Body);
    }

    [Fact]
    public async Task CopyingASceneAsOverride_IntoAPluginLackingItsQuest_CopiesTheQuestInWithItsFields_AndTheSceneIntoItsScenesFolder()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Scene.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var quest = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString());
        Assert.NotNull(quest);
        Assert.True(quest.Require().IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, quest.EditorId);
        Assert.StartsWith(FolderOf(fixture, fixture.Quest, "Scenes"), DestinationFile(fixture, fixture.Scene), StringComparison.Ordinal);

        using var binary = await fixture.CompiledAsync(fixture.DestinationPlugin);
        var compiled = binary.Quests.Single(q => q.FormKey == fixture.Quest);
        Assert.Equal(ContainerCopyFixture.SceneEditorId, Assert.Single(compiled.Scenes).EditorID);
        Assert.Empty(compiled.DialogTopics);
    }

    [Fact]
    public async Task CopyingATopicAsOverride_IntoAPluginLackingItsQuest_CopiesTheQuestIn_AndLandsTheTopicWithEmptyResponses()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.DialogTopic.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var copiedQuest = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()).Require();
        Assert.True(copiedQuest.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, copiedQuest.EditorId);
        var topic = fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString());
        Assert.NotNull(topic);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, topic.Require().EditorId);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.Response1.ToString()));
        Assert.False(JsonDocument.Parse(topic.Body).RootElement.TryGetProperty("Responses", out _));

        using var binary = await fixture.CompiledAsync(fixture.DestinationPlugin);
        var compiledTopic = Assert.Single(binary.Quests.Single(q => q.FormKey == fixture.Quest).DialogTopics);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, compiledTopic.EditorID);
        Assert.Empty(compiledTopic.Responses);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CopyingAResponseAsOverride_IntoAPluginLackingItsTopicAndQuest_CopiesBothIn_EachIntoItsContainersFolder(bool fromPluginSource)
    {
        using var fixture = fromPluginSource ? ContainerCopyFixture.CreateWithCompiledPluginSource() : ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Response2.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var quest = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString());
        Assert.NotNull(quest);
        Assert.True(quest.Require().IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, quest.EditorId);
        var topic = fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString());
        Assert.NotNull(topic);
        Assert.True(topic.Require().IsPartialForm());
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, topic.EditorId);
        Assert.StartsWith(FolderOf(fixture, fixture.Quest, "DialogTopics"), DestinationFile(fixture, fixture.DialogTopic), StringComparison.Ordinal);
        Assert.StartsWith(FolderOf(fixture, fixture.DialogTopic, "Responses"), DestinationFile(fixture, fixture.Response2), StringComparison.Ordinal);

        using var binary = await fixture.CompiledAsync(fixture.DestinationPlugin);
        var compiledTopic = Assert.Single(binary.Quests.Single(q => q.FormKey == fixture.Quest).DialogTopics);
        Assert.Equal(ContainerCopyFixture.Response2EditorId, Assert.Single(compiledTopic.Responses).EditorID);
    }
}
