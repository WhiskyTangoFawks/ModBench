using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class ResponseWriteApiTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private EditRecordHandler EditService() => _fixture.EditHandler;

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
        var result = await CompileServices.Over(_fixture.LoadOrder)
            .CompileAsync(_fixture.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName)),
            GameRelease.Fallout4);
        return [.. ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == _fixture.Quest)
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
        var result = _fixture.DeleteHandler.DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.Response.ToString())]);

        Assert.Empty(result.Refused);
        var after = QuestText;
        Assert.DoesNotContain($"\"{ContainerModFixture.ResponseEditorId}\"", after, StringComparison.Ordinal);
        Assert.Contains($"\"{ContainerModFixture.Response2EditorId}\"", after, StringComparison.Ordinal);
        Assert.Equal([_fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

        Assert.Null(_fixture.Document(_fixture.Response.ToString()));
        Assert.True(_fixture.Uses(_fixture.Response.ToString()));
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
        Assert.Equal([_fixture.DocumentFile(_fixture.Quest.ToString()).Require()], _fixture.ChangedDocumentFiles());

        Assert.Equal([result.NewFormKey.Require(), _fixture.Response2.ToString()], ResponseFormKeys());

        Assert.Equal([ContainerModFixture.ResponseEditorId, ContainerModFixture.Response2EditorId], await CompiledResponseEditorIds());
    }

    [Fact]
    public void ARefusedResponseEdit_LeavesTheTopicDocumentAndTheResponseItselfUntouched()
    {
        var before = QuestText;
        var responseBefore = _fixture.Document(_fixture.Response.ToString()).Require().Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(before, QuestText);
        Assert.Empty(_fixture.ChangedFormKeys());
        Assert.Equal(responseBefore, _fixture.Document(_fixture.Response.ToString()).Require().Body);
    }

    [Fact]
    public async Task CopyingAResponseAsOverride_IntoAPluginLackingItsTopic_MintsABarePartialFormTopicWithTheResponseInline()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsOverride(
            fixture.SourcePlugin, fixture.Response1.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.True(fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()).Require().IsPartialForm());
        var mintedTopic = fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString());
        Assert.NotNull(mintedTopic);
        Assert.True(mintedTopic.IsPartialForm());
        Assert.Equal(
            fixture.Response1.ToString(),
            Assert.Single(JsonDocument.Parse(mintedTopic.Body).RootElement.GetProperty("Responses").EnumerateArray())
                .GetProperty("FormKey").GetString());

        Assert.Equal(fixture.Quest.ToString(), fixture.DocumentCarrying(fixture.DestinationPlugin, ContainerCopyFixture.Response1EditorId).FormKey);

        var compile = await CompileServices.Over(fixture.LoadOrder)
            .CompileAsync(fixture.DestinationPlugin);
        Assert.True(compile.Succeeded, compile.RefusalReason);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), Path.Combine(fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName)),
            GameRelease.Fallout4);
        var topic = ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == fixture.DialogTopic);
        Assert.Equal(ContainerCopyFixture.Response1EditorId, Assert.Single(topic.Responses).EditorID);
    }
}
