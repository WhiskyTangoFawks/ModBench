using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>A response lives inline in its topic's document, so every gesture on one patches that
/// document at the response's element only, and compile keeps the document's order.</summary>
public sealed class ResponseWriteApiTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private EditRecordHandler EditService() => _fixture.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string TopicFile => _fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId);

    // The topic document's own Responses array, in document order — the only order a response has.
    private IReadOnlyList<string> ResponseFormKeys()
    {
        using var topic = JsonDocument.Parse(_fixture.Document(_fixture.DialogTopic.ToString()).Require().Body);
        return [.. topic.RootElement.GetProperty("Responses").EnumerateArray()
            .Select(response => response.GetProperty("FormKey").GetString().Require())];
    }

    private IReadOnlyList<string> CompiledResponseEditorIds()
    {
        var result = CompileServices.Over(_fixture.LoadOrder)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName)),
            GameRelease.Fallout4);
        return [.. ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic)
            .Responses.Select(r => r.EditorID.Require())];
    }

    [Fact]
    public void SettingAResponsesField_ChangesTheTopicDocumentAtThatPathAndNowhereElse_AndCompilesInOrder()
    {
        var before = File.ReadAllText(TopicFile);
        Assert.Empty(_fixture.GitStatus());

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "EditorID", Json("\"RenamedResponse\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace($"\"EditorID\": \"{ContainerModFixture.ResponseEditorId}\"", "\"EditorID\": \"RenamedResponse\"", StringComparison.Ordinal),
            File.ReadAllText(TopicFile));
        var changed = Assert.Single(_fixture.GitStatus());
        Assert.EndsWith(Path.GetFileName(TopicFile), changed, StringComparison.Ordinal);

        Assert.Equal("RenamedResponse", _fixture.Document(_fixture.Response.ToString()).Require().EditorId);
        Assert.Equal(["RenamedResponse", ContainerModFixture.Response2EditorId], CompiledResponseEditorIds());
    }

    [Fact]
    public void DeletingAResponse_RemovesItsElementFromTheTopicDocument_LeavingItsSiblingInPlace_AndCompiles()
    {
        var result = _fixture.DeleteHandler.DeleteRecord(_fixture.Plugin, _fixture.Response.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(TopicFile);
        Assert.DoesNotContain($"\"{ContainerModFixture.ResponseEditorId}\"", after, StringComparison.Ordinal);
        Assert.Contains($"\"{ContainerModFixture.Response2EditorId}\"", after, StringComparison.Ordinal);
        Assert.Equal([Path.GetFileName(TopicFile)], _fixture.GitStatus().Select(Path.GetFileName));

        Assert.Null(_fixture.Document(_fixture.Response.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.Response.ToString(), "info", ContainerModFixture.ResponseEditorId));
        Assert.Equal([_fixture.Response2.ToString()], ResponseFormKeys());

        Assert.Equal([ContainerModFixture.Response2EditorId], CompiledResponseEditorIds());
    }

    [Fact]
    public void RenumberingAResponse_ChangesItsFormKeyInPlaceInTheTopicDocument_AndCompilesInOrder()
    {
        var result = _fixture.RenumberHandler.RenumberRecord(_fixture.Plugin, _fixture.Response.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(TopicFile);
        Assert.Contains(result.NewFormKey.Require(), after, StringComparison.Ordinal);
        Assert.DoesNotContain(_fixture.Response.ToString(), after, StringComparison.Ordinal);
        Assert.Equal([Path.GetFileName(TopicFile)], _fixture.GitStatus().Select(Path.GetFileName));

        Assert.Equal([result.NewFormKey.Require(), _fixture.Response2.ToString()], ResponseFormKeys());

        Assert.Equal([ContainerModFixture.ResponseEditorId, ContainerModFixture.Response2EditorId], CompiledResponseEditorIds());
    }

    [Fact]
    public void ARefusedResponseEdit_LeavesTheTopicDocumentAndTheResponseItselfUntouched()
    {
        var before = File.ReadAllText(TopicFile);
        var responseBefore = _fixture.Document(_fixture.Response.ToString()).Require().Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(before, File.ReadAllText(TopicFile));
        Assert.Empty(_fixture.GitStatus());
        Assert.Equal(responseBefore, _fixture.Document(_fixture.Response.ToString()).Require().Body);
    }

    // The container rule's mint: the destination lacks the topic and the quest, so both land bare
    // and Partial Form, with the response inline in the topic's document.
    [Fact]
    public void CopyingAResponseAsOverride_IntoAPluginLackingItsTopic_MintsABarePartialFormTopicWithTheResponseInline()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
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

        var topicFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.Response1EditorId);
        Assert.Contains($"\"FormKey\": \"{fixture.DialogTopic}\"", File.ReadAllText(topicFile), StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(fixture.DestinationSourceRoot, "Responses", SearchOption.AllDirectories));

        var compile = CompileServices.Over(fixture.LoadOrder)
            .Compile(fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compile.Succeeded, compile.RefusalReason);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), Path.Combine(fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName)),
            GameRelease.Fallout4);
        var topic = ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == fixture.DialogTopic);
        Assert.Equal(ContainerCopyFixture.Response1EditorId, Assert.Single(topic.Responses).EditorID);
    }
}
