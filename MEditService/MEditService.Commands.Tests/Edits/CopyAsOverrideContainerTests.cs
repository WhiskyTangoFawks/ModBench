using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsOverrideContainerTests
{
    [Fact]
    public void CopyRecordAsOverride_OnAQuest_Succeeds_OwnFieldsLand_ChildListsEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var document = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString());
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, document.EditorId);

        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.Scene.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.DialogBranch.ToString()));
        var questText = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.QuestEditorId).Body;
        foreach (var slot in new[] { "DialogTopics", "DialogBranches", "Scenes" })
            Assert.DoesNotContain($"\"{slot}\"", questText, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorCell_Succeeds_OwnFieldsLand_EmbeddedSlotsEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

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
    public void CopyRecordAsOverride_OnAWorldspace_Succeeds_OwnFieldsLand_TopCellEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var document = fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString());
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, document.EditorId);

        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TopCell.ToString()));
        Assert.DoesNotContain(
            ContainerCopyFixture.TopCellEditorId,
            fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.WorldspaceEditorId).Body,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_OnAPlacedReference_WhenDestinationAlreadyOverridesTheCell_AppendsWithoutPartialFormingTheCell()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = fixture.CopyHandler;
        Assert.True(service.CopyAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var child = fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString());
        Assert.NotNull(child);
        Assert.Equal(ContainerCopyFixture.PersistentRefEditorId, child.EditorId);

        var cellText = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.InteriorCellEditorId).Body;
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, cellText, StringComparison.Ordinal);

        Assert.False(fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString()).Require().IsPartialForm());
    }

    [Fact]
    public void CopyRecordAsOverride_OnATopCellPlacedReference_Refuses_WhenDestinationHasNoCellOverride()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.TopCellRef.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TopCellRef.ToString()));
    }

    [Fact]
    public void CopyRecordAsOverride_OnATopCellItself_Refuses()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.TopCell.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TopCell.ToString()));
    }

    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorPlacedReference_MintsPartialFormWrldAndCellOverrides_WhenDestinationHasNeither()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        Assert.True(fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require().IsPartialForm());

        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.True(cell.IsPartialForm());

        var placed = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString());
        Assert.NotNull(placed);
        Assert.Equal(ContainerCopyFixture.ExteriorPersistentRefEditorId, placed.EditorId);

        var cellText = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.ExteriorPersistentRefEditorId).Body;
        Assert.Contains(ContainerCopyFixture.ExteriorPersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.ExteriorTemporaryRefEditorId, cellText, StringComparison.Ordinal);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));

        fixture.AssertDestinationCellSitsAt(
            fixture.ExteriorCell.ToString(), editorId: null,
            ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY, ContainerCopyFixture.ExteriorSubX, ContainerCopyFixture.ExteriorSubY);
        Assert.Contains(
            $"\"{ContainerCopyFixture.ExteriorGridX}, {ContainerCopyFixture.ExteriorGridY}\"",
            cell.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_OnAnExteriorPlacedReferenceFromATrackedSource_MintsAtTheSourcesOwnBlock()
    {
        using var fixture = ContainerCopyFixture.CreateWithTrackedSource();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        fixture.AssertDestinationCellSitsAt(
            fixture.ExteriorCell.ToString(), editorId: null,
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

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.True(cell.IsPartialForm());
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString()));

        var slots = JsonDocument.Parse(cell.Body).RootElement;
        Assert.Equal(
            fixture.ExteriorTemporaryRef.ToString(),
            Assert.Single(slots.GetProperty("Temporary").EnumerateArray()).GetProperty("FormKey").GetString());
        Assert.False(slots.TryGetProperty("Persistent", out _));
    }

    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorCellItself_MintsPartialFormWrldOverride_CellLandsOwnFieldsOnlyAndNotPartialForm()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        Assert.True(fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require().IsPartialForm());

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
    public void CopyRecordAsOverride_OnAnInteriorPlacedReference_AutoCreatesTheCellAsPartialForm_WhenMissing()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var mintedCell = fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString());
        Assert.NotNull(mintedCell);
        Assert.True(mintedCell.IsPartialForm());

        var cellText = fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.PersistentRefEditorId).Body;
        Assert.DoesNotContain(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}", cellText, StringComparison.Ordinal);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);

        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString()));
    }

    [Fact]
    public void CopyRecordAsOverride_OnAResponse_WhenDestinationAlreadyHoldsItsTopicEmbeddedInTheQuest_LandsAfterTheExistingResponseWithEveryOtherQuestByteUntouched()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = fixture.CopyHandler;
        Assert.True(service.CopyAsOverride(
            fixture.SourcePlugin, fixture.Response2.ToString(), fixture.DestinationPlugin).Applied);

        var before = JsonNode.Parse(fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.Response2EditorId).Body).Require();
        var topicBefore = Assert.Single(before["DialogTopics"].Require().AsArray()).Require().AsObject();
        var existingResponse = topicBefore["Responses"].Require()[0].Require().ToJsonString();
        topicBefore.Remove("Responses");

        var result = service.CopyAsOverride(
            fixture.SourcePlugin, fixture.Response1.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var after = JsonNode.Parse(fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.Response2EditorId).Body).Require();
        var topicAfter = Assert.Single(after["DialogTopics"].Require().AsArray()).Require().AsObject();
        var responsesAfter = topicAfter["Responses"].Require().AsArray();

        Assert.Equal(2, responsesAfter.Count);
        Assert.Equal(existingResponse, responsesAfter[0].Require().ToJsonString());
        Assert.Equal(fixture.Response1.ToString(), responsesAfter[1].Require()["FormKey"].Require().GetValue<string>());

        topicAfter.Remove("Responses");
        Assert.Equal(before.ToJsonString(), after.ToJsonString());
    }
}
