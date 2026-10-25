using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class QuestChildEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();
    private readonly List<IDisposable> _compiled = [];

    public void Dispose()
    {
        _compiled.ForEach(compiled => compiled.Dispose());
        _fixture.Dispose();
    }

    private TestEditor EditService() => _fixture.EditHandler;

    private string QuestText => _fixture.Document(_fixture.Quest.ToString()).Require().Body;

    private async Task<IQuestGetter> CompiledQuest()
    {
        var compiled = await _fixture.CompiledAsync(_fixture.Plugin);
        _compiled.Add(compiled);
        return compiled.Quests.Single(q => q.FormKey == _fixture.Quest);
    }

    private void AssertOnlyTheQuestDocumentChanged() =>
        Assert.Equal([_fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

    private IReadOnlyList<string> QuestSlot(string slotName)
    {
        using var document = JsonDocument.Parse(_fixture.Document(_fixture.Quest.ToString()).Require().Body);
        return [.. document.RootElement.GetProperty(slotName).EnumerateArray()
            .Select(child => child.GetProperty("FormKey").GetString().Require())];
    }

    public static TheoryData<string, Func<ContainerModFixture, FormKey>, string, Func<IQuestGetter, IEnumerable<string>>, string[]> QuestChildKinds => new()
    {
        {
            "topic", f => f.DialogTopic2, ContainerModFixture.DialogTopic2EditorId, q => q.DialogTopics.Select(t => t.EditorID.Require()),
            [ContainerModFixture.DialogTopicEditorId, "Renamed", ContainerModFixture.DialogTopic3EditorId]
        },
        { "branch", f => f.DialogBranch, ContainerModFixture.DialogBranchEditorId, q => q.DialogBranches.Select(b => b.EditorID.Require()), ["Renamed"] },
        { "scene", f => f.Scene, ContainerModFixture.SceneEditorId, q => q.Scenes.Select(s => s.EditorID.Require()), ["Renamed"] },
    };

    [Theory]
    [MemberData(nameof(QuestChildKinds))]
    public async Task SettingAQuestChildsField_ChangesTheQuestDocumentAtThatPathAndNowhereElse_AndCompilesInOrder(
        string _, Func<ContainerModFixture, FormKey> child, string editorId, Func<IQuestGetter, IEnumerable<string>> siblings, string[] compiled)
    {
        var before = QuestText;
        Assert.Empty(_fixture.ChangedFormKeys());

        var result = EditService().Set(_fixture.Plugin, child(_fixture).ToString(), "EditorID", Json("\"Renamed\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace($"\"EditorID\": \"{editorId}\"", "\"EditorID\": \"Renamed\"", StringComparison.Ordinal),
            QuestText);
        AssertOnlyTheQuestDocumentChanged();

        Assert.Equal("Renamed", _fixture.Document(child(_fixture).ToString()).Require().EditorId);
        Assert.Equal(compiled, siblings(await CompiledQuest()));
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
        Assert.All(
            new[] { ContainerModFixture.DialogTopicEditorId, ContainerModFixture.ResponseEditorId, ContainerModFixture.Response2EditorId },
            gone => Assert.DoesNotContain($"\"{gone}\"", after, StringComparison.Ordinal));
        Assert.All(
            new[] { ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId, ContainerModFixture.DialogBranchEditorId, ContainerModFixture.SceneEditorId },
            kept => Assert.Contains($"\"{kept}\"", after, StringComparison.Ordinal));
        AssertOnlyTheQuestDocumentChanged();

        Assert.DoesNotContain(new[] { _fixture.DialogTopic, _fixture.Response, _fixture.Response2 }, gone => _fixture.Document(gone.ToString()) is not null);
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
        Assert.Equal([_fixture.HeaderDocumentFile(), _fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

        Assert.Equal(
            [_fixture.DialogTopic.ToString(), result.NewFormKey.Require(), _fixture.DialogTopic3.ToString()],
            QuestSlot(nameof(Quest.DialogTopics)));

        Assert.Equal(
            [ContainerModFixture.DialogTopicEditorId, ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId],
            (await CompiledQuest()).DialogTopics.Select(t => t.EditorID.Require()));
    }
}
