using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsNewContainerTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private IReadOnlyList<JsonElement> Responses(string topicFormKey)
    {
        var topic = _fixture.Document(_fixture.DestinationPlugin, topicFormKey);
        Assert.NotNull(topic);
        return JsonDocument.Parse(topic.Body).RootElement.TryGetProperty("Responses", out var responses)
            ? [.. responses.EnumerateArray()]
            : [];
    }

    private static string Member(JsonElement response, string name) => response.GetProperty(name).GetString().Require();

    [Fact]
    public async Task CopyAsNewRecord_OnADialogTopicWithResponses_LandsTheTopicWithoutItsResponses()
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.DialogTopic.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        var quest = _fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString());
        Assert.NotNull(quest);
        Assert.True(quest.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, quest.EditorId);

        Assert.Empty(Responses(newFormKey));

        using var compiled = await _fixture.CompiledAsync(_fixture.DestinationPlugin);
        var compiledQuest = compiled.Quests.Single(q => q.FormKey == _fixture.Quest);
        var compiledTopic = compiledQuest.DialogTopics.Single(t => t.FormKey.ToString() == newFormKey);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId + "DUPLICATE001", compiledTopic.EditorID);
        Assert.Empty(compiledTopic.Responses);
    }

    [Fact]
    public void CopyAsNewRecord_OnADialogTopic_CopiedTwice_EachRecordGetsItsOwnNextCounter()
    {
        var first = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.DialogTopic.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);
        first.OnlyLanded();

        var second = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.DialogTopic.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);
        var secondFormKey = second.OnlyLanded().Require();

        var secondTopic = _fixture.Document(_fixture.DestinationPlugin, secondFormKey);
        Assert.NotNull(secondTopic);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId + "DUPLICATE002", secondTopic.EditorId);
    }

    [Fact]
    public async Task CopyAsNewRecord_OnADialogTopic_WhenDestinationAlreadyOverridesTheQuest_AddsToItsDialogTopicsAndNothingElse()
    {
        _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Quest.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();
        var questBefore = JsonNode.Parse(_fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.QuestEditorId).Body).Require();

        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.DialogTopic.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        var questAfter = JsonNode.Parse(_fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.QuestEditorId).Body).Require().AsObject();
        Assert.True(questAfter.Remove(nameof(Quest.DialogTopics), out var topics));
        Assert.Equal(newFormKey, Assert.Single(topics.Require().AsArray()).Require()["FormKey"].Require().GetValue<string>());
        Assert.Equal(questBefore.ToJsonString(), questAfter.ToJsonString());
        Assert.False(_fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString()).Require().IsPartialForm());

        using var compiled = await _fixture.CompiledAsync(_fixture.DestinationPlugin);
        var compiledQuest = compiled.Quests.Single(q => q.FormKey == _fixture.Quest);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, compiledQuest.EditorID);
        Assert.Single(compiledQuest.DialogTopics, t => t.FormKey.ToString() == newFormKey);
    }

    [Fact]
    public void CopyAsNewRecord_OnASelfLinkingResponse_RemapsTheLinkOntoTheNewFormKey()
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Response1.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        var landed = Assert.Single(Responses(_fixture.DialogTopic.ToString()));
        Assert.Equal(newFormKey, Member(landed, "PreviousDialog"));
    }

    [Fact]
    public void CopyAsNewRecord_OnAResponseLinkingItsSibling_LeavesTheLinkAtTheOriginal()
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Response2.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var landed = Assert.Single(Responses(_fixture.DialogTopic.ToString()));
        Assert.Equal(_fixture.Response1.ToString(), Member(landed, "PreviousDialog"));
    }

    [Fact]
    public void CopyAsNewRecord_OnAReferenceInAWorldspacesPersistentCell_CopiesTheWorldspaceAndItsPersistentCellIn()
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.TopCellRef.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        var worldspace = _fixture.Document(_fixture.DestinationPlugin, _fixture.Worldspace.ToString()).Require();
        Assert.True(worldspace.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, worldspace.EditorId);
        var topCell = JsonDocument.Parse(worldspace.Body).RootElement.GetProperty("TopCell");
        Assert.Equal(ContainerCopyFixture.TopCellEditorId, topCell.GetProperty("EditorID").GetString());
        var landed = Assert.Single(topCell.GetProperty("Temporary").EnumerateArray());
        Assert.Equal(newFormKey, landed.GetProperty("FormKey").GetString());
    }

    [Fact]
    public async Task CopyAsNewRecord_OnAResponseAlone_AutoCreatesTheQuestAndTopicChain()
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Response1.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        var quest = _fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString()).Require();
        Assert.True(quest.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, quest.EditorId);
        var topic = _fixture.Document(_fixture.DestinationPlugin, _fixture.DialogTopic.ToString()).Require();
        Assert.True(topic.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, topic.EditorId);

        var landed = Assert.Single(Responses(_fixture.DialogTopic.ToString()));
        Assert.Equal(newFormKey, Member(landed, "FormKey"));

        Assert.Contains(
            newFormKey,
            _fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.Response1EditorId + "DUPLICATE001").Body,
            StringComparison.Ordinal);

        using var compiled = await _fixture.CompiledAsync(_fixture.DestinationPlugin);
        var compiledTopic = compiled.Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic);
        var compiledResponse = Assert.Single(compiledTopic.Responses);
        Assert.Equal(newFormKey, compiledResponse.FormKey.ToString());
        Assert.Equal(ContainerCopyFixture.Response1EditorId + "DUPLICATE001", compiledResponse.EditorID);
    }

    [Fact]
    public async Task CopyAsNewRecord_OnAQuest_LandsANewQuestUnderAFreshFormKey_WithoutItsTopics()
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Quest.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        var document = _fixture.Document(_fixture.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.QuestEditorId + "DUPLICATE001", document.EditorId);

        var questText = _fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.QuestEditorId + "DUPLICATE001").Body;
        Assert.DoesNotContain(ContainerCopyFixture.DialogTopicEditorId, questText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.SceneEditorId, questText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.DialogBranchEditorId, questText, StringComparison.Ordinal);

        using var compiled = await _fixture.CompiledAsync(_fixture.DestinationPlugin);
        var compiledQuest = compiled.Quests.Single(q => q.FormKey.ToString() == newFormKey);
        Assert.Equal(ContainerCopyFixture.QuestEditorId + "DUPLICATE001", compiledQuest.EditorID);
        Assert.Empty(compiledQuest.DialogTopics);
        Assert.Empty(compiledQuest.DialogBranches);
        Assert.Empty(compiledQuest.Scenes);
    }

    public static TheoryData<string, Func<ContainerCopyFixture, FormKey>> ChildrenWhoseContainersTheDestinationLacks => new()
    {
        { "a response, whose quest and topic it copies in", fixture => fixture.Response1 },
        { "a reference in an exterior cell, whose worldspace and cell it copies in", fixture => fixture.ExteriorPersistentRef },
    };

    [Theory]
    [MemberData(nameof(ChildrenWhoseContainersTheDestinationLacks))]
    public void CopyAsNewRecord_OfAChildWhoseContainersItCopiesIn_MovesTheDestinationsNextObjectIdPastIt(string _, Func<ContainerCopyFixture, FormKey> child)
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, child(_fixture).ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        Assert.Equal("000801:ContainerDestination.esp", result.OnlyLanded());
        Assert.Equal(0x802u, _fixture.NextObjectId(_fixture.DestinationPlugin));
    }

    [Fact]
    public void CopyAsNewRecord_OfAResponseIntoATopicTheDestinationHolds_MovesTheDestinationsNextObjectIdPastIt()
    {
        _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Response1.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var second = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Response2.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        Assert.Equal("000802:ContainerDestination.esp", second.OnlyLanded());
        Assert.Equal(0x803u, _fixture.NextObjectId(_fixture.DestinationPlugin));
    }
}
