using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class ResponseEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private TestEditor EditService() => _fixture.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string QuestText => _fixture.Document(_fixture.Quest.ToString()).Require().Body;

    private IReadOnlyList<string> ResponseFormKeys()
    {
        using var topic = JsonDocument.Parse(_fixture.Document(_fixture.DialogTopic.ToString()).Require().Body);
        return [.. topic.RootElement.GetProperty("Responses").EnumerateArray()
            .Select(response => response.GetProperty("FormKey").GetString().Require())];
    }

    private async Task<IReadOnlyList<string>> CompiledResponseEditorIds()
    {
        using var compiled = await _fixture.CompiledAsync(_fixture.Plugin);
        return [.. compiled.Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic)
            .Responses.Select(r => r.EditorID.Require())];
    }

    [Fact]
    public async Task SettingAResponsesField_ChangesTheQuestDocumentAtThatPathAndNowhereElse_AndCompilesInOrder()
    {
        var before = QuestText;
        Assert.Empty(_fixture.ChangedFormKeys());

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "EditorID", Json("\"RenamedResponse\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace($"\"EditorID\": \"{ContainerModFixture.ResponseEditorId}\"", "\"EditorID\": \"RenamedResponse\"", StringComparison.Ordinal),
            QuestText);
        Assert.Equal([_fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

        Assert.Equal("RenamedResponse", _fixture.Document(_fixture.Response.ToString()).Require().EditorId);
        Assert.Equal(["RenamedResponse", ContainerModFixture.Response2EditorId], await CompiledResponseEditorIds());
    }

    [Fact]
    public async Task DeletingAResponse_RemovesItsElementFromTheTopicDocument_LeavingItsSiblingInPlace_AndCompiles()
    {
        var result = _fixture.DeleteHandler.DeleteRecordsSync([new RecordAt(_fixture.Plugin, _fixture.Response.ToString())]);

        Assert.Empty(result.Refused);
        var after = QuestText;
        Assert.DoesNotContain($"\"{ContainerModFixture.ResponseEditorId}\"", after, StringComparison.Ordinal);
        Assert.Contains($"\"{ContainerModFixture.Response2EditorId}\"", after, StringComparison.Ordinal);
        Assert.Equal([_fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

        Assert.Null(_fixture.Document(_fixture.Response.ToString()));
        Assert.Equal([_fixture.Response2.ToString()], ResponseFormKeys());

        Assert.Equal([ContainerModFixture.Response2EditorId], await CompiledResponseEditorIds());
    }

    [Fact]
    public async Task EditingTheFormIdOfAResponse_ChangesItsFormKeyInPlaceInTheTopicDocument_AndCompilesInOrder()
    {
        var result = _fixture.EditHandler.SetFormId(
            _fixture.Plugin, _fixture.Response.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        var after = QuestText;
        Assert.Contains(result.NewFormKey.Require(), after, StringComparison.Ordinal);
        Assert.DoesNotContain(_fixture.Response.ToString(), after, StringComparison.Ordinal);
        Assert.Equal([_fixture.HeaderDocumentFile(), _fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

        Assert.Equal([result.NewFormKey.Require(), _fixture.Response2.ToString()], ResponseFormKeys());

        Assert.Equal([ContainerModFixture.ResponseEditorId, ContainerModFixture.Response2EditorId], await CompiledResponseEditorIds());
    }

    [Fact]
    public void ARefusedResponseEdit_AnswersNoChanges()
    {
        var before = QuestText;
        var responseBefore = _fixture.Document(_fixture.Response.ToString()).Require().Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(before, QuestText);
        Assert.Empty(_fixture.ChangedFormKeys());
        Assert.Equal(responseBefore, _fixture.Document(_fixture.Response.ToString()).Require().Body);
    }
}
