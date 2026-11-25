using System.Text.Json;
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

    public static TheoryData<string, Func<ContainerCopyFixture, (FormKey Child, FormKey Container)>> ChildrenSelectedBeforeTheirContainers => new()
    {
        { "an exterior cell before its worldspace", f => (f.ExteriorCell, f.Worldspace) },
        { "a topic before its quest", f => (f.DialogTopic, f.Quest) },
    };

    [Theory]
    [MemberData(nameof(ChildrenSelectedBeforeTheirContainers))]
    public void CopyRecordAsOverride_OfAChildSelectedBeforeItsContainer_LandsBoth_ContainerFirst(
        string _, Func<ContainerCopyFixture, (FormKey Child, FormKey Container)> selected)
    {
        using var fixture = ContainerCopyFixture.Create();
        var (child, container) = selected(fixture);

        var result = fixture.CopyHandler.CopySync(
            [new RecordAt(fixture.SourcePlugin, child.ToString()), new RecordAt(fixture.SourcePlugin, container.ToString())],
            CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        Assert.Empty(result.Refused);
        Assert.Equal(2, result.Applied.Count);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, container.ToString()));
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, child.ToString()));
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

    private static string DestinationFile(ContainerCopyFixture fixture, FormKey record) =>
        SourceModTree.DocumentFile(fixture.DestinationModFolder, fixture.DestinationPlugin, record.ToString()).Require();

    private static string FolderOf(ContainerCopyFixture fixture, FormKey container, string slot) =>
        Path.Combine(Path.GetDirectoryName(DestinationFile(fixture, container)).Require(), slot) + Path.DirectorySeparatorChar;

    [Fact]
    public void CopyingATopicAsOverride_IntoAPluginLackingItsQuest_CopiesTheQuestIn_AndLandsTheTopicWithEmptyResponses()
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
    }

    public static TheoryData<string, Func<ContainerCopyFixture>> Sources => new()
    {
        { "read from the plugin file", ContainerCopyFixture.Create },
        { "read from the plugin source", ContainerCopyFixture.CreateWithCompiledPluginSource },
    };

    [Theory]
    [MemberData(nameof(Sources))]
    public void CopyingAResponseAsOverride_IntoAPluginLackingItsTopicAndQuest_CopiesBothIn_EachIntoItsContainersFolder(
        string _, Func<ContainerCopyFixture> source)
    {
        using var fixture = source();

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
    }
}
