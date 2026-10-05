using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsNewContainerTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose()
    {
        foreach (var overlay in _overlays) overlay.Dispose();
        _fixture.Dispose();
    }

    private readonly List<IDisposable> _overlays = [];

    private IReadOnlyList<JsonElement> Responses(string topicFormKey)
    {
        var topic = _fixture.Document(_fixture.DestinationPlugin, topicFormKey);
        Assert.NotNull(topic);
        return JsonDocument.Parse(topic.Body).RootElement.TryGetProperty("Responses", out var responses)
            ? [.. responses.EnumerateArray()]
            : [];
    }

    private static string Member(JsonElement response, string name) => response.GetProperty(name).GetString().Require();

    private async Task<IFallout4ModGetter> ImportCompiled()
    {
        var compileResult = await CompileServices.Over(_fixture.LoadOrder)
            .CompileOneAsync(_fixture.DestinationPlugin);
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

        var pluginPath = Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), pluginPath), GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }

    [Fact]
    public async Task CopyAsNewRecord_OnADialogTopicWithResponses_LandsTheTopicWithoutItsResponses()
    {
        var result = _fixture.CopyHandler.CopyAsNew(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var newTopicFormKey = result.NewFormKey.Require();
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newTopicFormKey, StringComparison.OrdinalIgnoreCase);

        var quest = _fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString());
        Assert.NotNull(quest);
        Assert.True(quest.IsPartialForm());

        Assert.Empty(Responses(newTopicFormKey));

        var compiled = await ImportCompiled();
        var compiledQuest = compiled.Quests.Single(q => q.FormKey == _fixture.Quest);
        var compiledTopic = compiledQuest.DialogTopics.Single(t => t.FormKey.ToString() == newTopicFormKey);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId + "DUPLICATE001", compiledTopic.EditorID);
        Assert.Empty(compiledTopic.Responses);
    }

    [Fact]
    public void CopyAsNewRecord_OnADialogTopic_CopiedTwice_EachRecordGetsItsOwnNextCounter()
    {
        var first = _fixture.CopyHandler.CopyAsNew(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);
        Assert.True(first.Applied, first.Message);

        var second = _fixture.CopyHandler.CopyAsNew(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);
        Assert.True(second.Applied, second.Message);

        var secondTopic = _fixture.Document(_fixture.DestinationPlugin, second.NewFormKey.Require());
        Assert.NotNull(secondTopic);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId + "DUPLICATE002", secondTopic.EditorId);
    }

    [Fact]
    public async Task CopyAsNewRecord_OnADialogTopic_WhenDestinationAlreadyOverridesTheQuest_AddsToItsDialogTopicsAndNothingElse()
    {
        Assert.True(_fixture.CopyHandler.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin).Applied);
        var questBefore = JsonDocument.Parse(_fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.QuestEditorId).Body);

        var result = _fixture.CopyHandler.CopyAsNew(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        Assert.False(questBefore.RootElement.TryGetProperty(nameof(Quest.DialogTopics), out _));
        var questAfter = JsonDocument.Parse(_fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.QuestEditorId).Body);
        foreach (var property in questBefore.RootElement.EnumerateObject())
        {
            Assert.True(
                questAfter.RootElement.TryGetProperty(property.Name, out var now),
                $"quest document lost '{property.Name}'");
            Assert.Equal(property.Value.GetRawText(), now.GetRawText());
        }
        Assert.Equal(questBefore.RootElement.EnumerateObject().Count() + 1, questAfter.RootElement.EnumerateObject().Count());
        var landed = Assert.Single(questAfter.RootElement.GetProperty(nameof(Quest.DialogTopics)).EnumerateArray());
        Assert.Equal(result.NewFormKey, landed.GetProperty("FormKey").GetString());

        Assert.False(_fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString()).Require().IsPartialForm());


        var compiledQuest = (await ImportCompiled()).Quests.Single(q => q.FormKey == _fixture.Quest);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, compiledQuest.EditorID);
        Assert.Single(compiledQuest.DialogTopics, t => t.FormKey.ToString() == result.NewFormKey);
    }

    [Fact]
    public async Task CopyAsNewRecord_OnAResponseAlone_AutoCreatesTheQuestAndTopicChain()
    {
        var result = _fixture.CopyHandler.CopyAsNew(
            _fixture.SourcePlugin, _fixture.Response1.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey.Require();
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        Assert.True(_fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString()).Require().IsPartialForm());
        Assert.True(_fixture.Document(_fixture.DestinationPlugin, _fixture.DialogTopic.ToString()).Require().IsPartialForm());

        var landed = Assert.Single(Responses(_fixture.DialogTopic.ToString()));
        Assert.Equal(newFormKey, Member(landed, "FormKey"));

        Assert.Contains(
            newFormKey,
            _fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.Response1EditorId + "DUPLICATE001").Body,
            StringComparison.Ordinal);

        var compiledTopic = (await ImportCompiled()).Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic);
        var compiledResponse = Assert.Single(compiledTopic.Responses);
        Assert.Equal(newFormKey, compiledResponse.FormKey.ToString());
        Assert.Equal(ContainerCopyFixture.Response1EditorId + "DUPLICATE001", compiledResponse.EditorID);
    }

    [Fact]
    public async Task CopyAsNewRecord_OnAQuest_LandsANewQuestUnderAFreshFormKey_WithoutItsTopics()
    {
        var result = _fixture.CopyHandler.CopyAsNew(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey.Require();
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        var document = _fixture.Document(_fixture.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.QuestEditorId + "DUPLICATE001", document.EditorId);

        var questText = _fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.QuestEditorId + "DUPLICATE001").Body;
        Assert.DoesNotContain(ContainerCopyFixture.DialogTopicEditorId, questText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.SceneEditorId, questText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.DialogBranchEditorId, questText, StringComparison.Ordinal);

        var compiledQuest = (await ImportCompiled()).Quests.Single(q => q.FormKey.ToString() == newFormKey);
        Assert.Equal(ContainerCopyFixture.QuestEditorId + "DUPLICATE001", compiledQuest.EditorID);
        Assert.Empty(compiledQuest.DialogTopics);
        Assert.Empty(compiledQuest.DialogBranches);
        Assert.Empty(compiledQuest.Scenes);
    }
}
