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
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class QuestChildWriteApiTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private TestEditor EditService() => _fixture.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string QuestText => _fixture.Document(_fixture.Quest.ToString()).Require().Body;

    private async Task<IQuestGetter> CompiledQuest()
    {
        await CompileServices.Over(_fixture.LoadOrder).CompileLandedAsync(_fixture.Plugin);

        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName)),
            GameRelease.Fallout4);
        _overlays.Add(overlay);
        return ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == _fixture.Quest);
    }

    private readonly List<IDisposable> _overlays = [];

    private void AssertOnlyTheQuestDocumentChanged() =>
        Assert.Equal([_fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

    private IReadOnlyList<string> QuestSlot(string slotName) => SlotOf(_fixture.Quest, slotName);

    private IReadOnlyList<string> SlotOf(FormKey owner, string slotName)
    {
        using var document = JsonDocument.Parse(_fixture.Document(owner.ToString()).Require().Body);
        return [.. document.RootElement.GetProperty(slotName).EnumerateArray()
            .Select(child => child.GetProperty("FormKey").GetString().Require())];
    }

    public static TheoryData<string> QuestChildKinds => ["topic", "branch", "scene"];

    private (FormKey Child, string EditorId, Func<IQuestGetter, IEnumerable<string>> Siblings) Kind(string kind) => kind switch
    {
        "topic" => (_fixture.DialogTopic2, ContainerModFixture.DialogTopic2EditorId, q => q.DialogTopics.Select(t => t.EditorID.Require())),
        "branch" => (_fixture.DialogBranch, ContainerModFixture.DialogBranchEditorId, q => q.DialogBranches.Select(b => b.EditorID.Require())),
        "scene" => (_fixture.Scene, ContainerModFixture.SceneEditorId, q => q.Scenes.Select(s => s.EditorID.Require())),
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "No such quest child kind."),
    };

    [Theory]
    [MemberData(nameof(QuestChildKinds))]
    public async Task SettingAQuestChildsField_ChangesTheQuestDocumentAtThatPathAndNowhereElse_AndCompilesInOrder(string kind)
    {
        var (child, editorId, siblings) = Kind(kind);
        var before = QuestText;
        Assert.Empty(_fixture.ChangedFormKeys());

        var result = EditService().Set(_fixture.Plugin, child.ToString(), "EditorID", Json($"\"Renamed{kind}\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace($"\"EditorID\": \"{editorId}\"", $"\"EditorID\": \"Renamed{kind}\"", StringComparison.Ordinal),
            QuestText);
        AssertOnlyTheQuestDocumentChanged();

        Assert.Equal($"Renamed{kind}", _fixture.Document(child.ToString()).Require().EditorId);
        var compiled = siblings(await CompiledQuest()).ToList();
        Assert.Contains($"Renamed{kind}", compiled);
        if (kind == "topic")
        {
            Assert.Equal(
                [ContainerModFixture.DialogTopicEditorId, "Renamedtopic", ContainerModFixture.DialogTopic3EditorId], compiled);
        }
    }

    [Fact]
    public async Task RenamingANestedResponse_ChangesTheQuestDocumentAtTheResponsesElementOnly_AndCompilesInOrder()
    {
        var before = QuestText;

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "EditorID", Json("\"RenamedResponse\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace($"\"EditorID\": \"{ContainerModFixture.ResponseEditorId}\"", "\"EditorID\": \"RenamedResponse\"", StringComparison.Ordinal),
            QuestText);
        AssertOnlyTheQuestDocumentChanged();

        Assert.Equal("RenamedResponse", _fixture.Document(_fixture.Response.ToString()).Require().EditorId);
        Assert.Contains(_fixture.Response.ToString(), SlotOf(_fixture.DialogTopic, nameof(DialogTopic.Responses)));
        Assert.Equal(
            ["RenamedResponse", ContainerModFixture.Response2EditorId],
            (await CompiledQuest()).DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic).Responses.Select(r => r.EditorID.Require()));
    }

    [Fact]
    public async Task AddingMovingAndRemoving_OnANestedResponsesOwnArray_PatchTheQuestDocumentAtThatArray_AndCompileInOrder()
    {
        var service = EditService();
        var response = _fixture.Response.ToString();
        Assert.Equal(ContainerModFixture.ResponseLineNumbers.Select(l => (int)l), LineNumbersInDocument());

        var added = service.Edit(_fixture.Plugin, response, AddAt(Json("""{"ResponseNumber": 3}"""), Member("Responses")));
        Assert.True(added.Applied, added.Message);
        Assert.Equal([1, 2, 3], LineNumbersInDocument());

        var moved = service.Edit(_fixture.Plugin, response, MoveTo(0, Member("Responses"), At(2)));
        Assert.True(moved.Applied, moved.Message);
        Assert.Equal([3, 1, 2], LineNumbersInDocument());

        var removed = service.Edit(_fixture.Plugin, response, RemoveAt(Member("Responses"), At(1)));
        Assert.True(removed.Applied, removed.Message);
        Assert.Equal([3, 2], LineNumbersInDocument());

        AssertOnlyTheQuestDocumentChanged();
        Assert.Contains($"\"{ContainerModFixture.Response2EditorId}\"", QuestText, StringComparison.Ordinal);
        Assert.Equal(
            [3, 2],
            (await CompiledQuest()).DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic)
                .Responses.Single(r => r.FormKey == _fixture.Response).Responses.Select(l => (int)l.ResponseNumber));
    }

    private int[] LineNumbersInDocument()
    {
        var root = JsonNode.Parse(QuestText).Require().AsObject();
        var response = root[nameof(Quest.DialogTopics)].Require().AsArray()
            .SelectMany(t => t.Require()[nameof(DialogTopic.Responses)] as JsonArray ?? [])
            .Single(r => r.Require()[nameof(IMajorRecordGetter.FormKey)].Require().GetValue<string>() == _fixture.Response.ToString()).Require();
        return [.. response[nameof(DialogResponses.Responses)].Require().AsArray().Select(l => l.Require()[nameof(DialogResponse.ResponseNumber)].Require().GetValue<int>())];
    }

    [Fact]
    public async Task DeletingATopic_RemovesItAndItsResponsesFromTheQuestDocument_LeavingItsSiblingsInPlace_AndCompiles()
    {
        var result = _fixture.DeleteHandler.DeleteRecordsSync([new RecordAt(_fixture.Plugin, _fixture.DialogTopic.ToString())]);

        Assert.Empty(result.Refused);
        var after = QuestText;
        foreach (var gone in new[] { ContainerModFixture.DialogTopicEditorId, ContainerModFixture.ResponseEditorId, ContainerModFixture.Response2EditorId })
            Assert.DoesNotContain($"\"{gone}\"", after, StringComparison.Ordinal);
        foreach (var kept in new[] { ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId, ContainerModFixture.DialogBranchEditorId, ContainerModFixture.SceneEditorId })
            Assert.Contains($"\"{kept}\"", after, StringComparison.Ordinal);
        AssertOnlyTheQuestDocumentChanged();

        foreach (var (gone, recordType, editorId) in new[]
                 {
                     (_fixture.DialogTopic, "dial", ContainerModFixture.DialogTopicEditorId),
                     (_fixture.Response, "info", ContainerModFixture.ResponseEditorId),
                     (_fixture.Response2, "info", ContainerModFixture.Response2EditorId),
                 })
        {
            Assert.Null(_fixture.Document(gone.ToString()));
            Assert.True(_fixture.Uses(gone.ToString()));
        }
        Assert.Equal([_fixture.DialogTopic2.ToString(), _fixture.DialogTopic3.ToString()], QuestSlot(nameof(Quest.DialogTopics)));

        var compiled = await CompiledQuest();
        Assert.Equal([ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId], compiled.DialogTopics.Select(t => t.EditorID.Require()));
        Assert.Equal([ContainerModFixture.SceneEditorId], compiled.Scenes.Select(s => s.EditorID.Require()));
    }

    [Fact]
    public async Task EditingTheFormIdOfAMidListTopic_ChangesItsFormKeyInPlaceInTheQuestDocument_AndCompilesInOrder()
    {
        var result = _fixture.EditHandler.SetFormId(
            _fixture.Plugin, _fixture.DialogTopic2.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        var after = QuestText;
        Assert.Contains(result.NewFormKey.Require(), after, StringComparison.Ordinal);
        Assert.DoesNotContain(_fixture.DialogTopic2.ToString(), after, StringComparison.Ordinal);
        AssertOnlyTheQuestDocumentChanged();

        Assert.Equal(
            [_fixture.DialogTopic.ToString(), result.NewFormKey.Require(), _fixture.DialogTopic3.ToString()],
            QuestSlot(nameof(Quest.DialogTopics)));

        Assert.Equal(
            [ContainerModFixture.DialogTopicEditorId, ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId],
            (await CompiledQuest()).DialogTopics.Select(t => t.EditorID.Require()));
    }

    [Fact]
    public void ARefusedQuestChildEdit_LeavesTheQuestDocumentAndTheSceneItselfUntouched()
    {
        var before = QuestText;
        var sceneBefore = _fixture.Document(_fixture.Scene.ToString()).Require().Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.Scene.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(before, QuestText);
        Assert.Empty(_fixture.ChangedFormKeys());
        Assert.Equal(sceneBefore, _fixture.Document(_fixture.Scene.ToString()).Require().Body);
    }

    [Fact]
    public async Task CopyingASceneAsOverride_IntoAPluginLackingItsQuest_CopiesTheQuestInWithItsFieldsAndTheSceneInline()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Scene.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var quest = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString());
        Assert.NotNull(quest);
        Assert.False(quest.Require().IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, quest.EditorId);
        Assert.Equal(
            fixture.Scene.ToString(),
            Assert.Single(JsonDocument.Parse(quest.Body).RootElement.GetProperty("Scenes").EnumerateArray())
                .GetProperty("FormKey").GetString());

        Assert.Equal(fixture.Quest.ToString(), fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.SceneEditorId).FormKey);

        var compiled = (await CompileAndImport(fixture)).Quests.Single(q => q.FormKey == fixture.Quest);
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
        Assert.False(copiedQuest.IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, copiedQuest.EditorId);
        var topic = fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString());
        Assert.NotNull(topic);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, topic.Require().EditorId);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.Response1.ToString()));
        Assert.False(JsonDocument.Parse(topic.Body).RootElement.TryGetProperty("Responses", out _));

        var compiledTopic = Assert.Single((await CompileAndImport(fixture)).Quests.Single(q => q.FormKey == fixture.Quest).DialogTopics);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, compiledTopic.EditorID);
        Assert.Empty(compiledTopic.Responses);
    }

    [Fact]
    public async Task CopyingAResponseAsOverride_IntoAPluginLackingItsTopicAndQuest_CopiesBothIn_InOneQuestDocument()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopySync([new RecordAt(fixture.SourcePlugin, fixture.Response2.ToString())], CopyMode.Override, [fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var quest = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString());
        Assert.NotNull(quest);
        Assert.False(quest.Require().IsPartialForm());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, quest.EditorId);
        var topic = fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString());
        Assert.NotNull(topic);
        Assert.False(topic.Require().IsPartialForm());
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, topic.EditorId);
        Assert.Equal(
            fixture.DialogTopic.ToString(),
            Assert.Single(JsonDocument.Parse(quest.Body).RootElement.GetProperty("DialogTopics").EnumerateArray())
                .GetProperty("FormKey").GetString());
        Assert.Equal(
            fixture.Response2.ToString(),
            Assert.Single(JsonDocument.Parse(topic.Body).RootElement.GetProperty("Responses").EnumerateArray())
                .GetProperty("FormKey").GetString());

        Assert.Equal(fixture.Quest.ToString(), fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.Response2EditorId).FormKey);

        var compiledTopic = Assert.Single((await CompileAndImport(fixture)).Quests.Single(q => q.FormKey == fixture.Quest).DialogTopics);
        Assert.Equal(ContainerCopyFixture.Response2EditorId, Assert.Single(compiledTopic.Responses).EditorID);
    }

    private async Task<IFallout4ModGetter> CompileAndImport(ContainerCopyFixture fixture)
    {
        await CompileServices.Over(fixture.LoadOrder).CompileLandedAsync(fixture.DestinationPlugin);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), Path.Combine(fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName)),
            GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }
}
