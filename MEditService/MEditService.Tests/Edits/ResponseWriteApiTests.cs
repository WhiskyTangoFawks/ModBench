using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>A response lives inline in its topic's document, so every gesture on one patches that
/// document at the response's element only, the index re-derives from it, and compile keeps the
/// document's order.</summary>
public sealed class ResponseWriteApiTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private ProjectingEditService EditService() =>
        ProjectingEditService.Over(_fixture.Mirror);

    private IRecordIndex Index => _fixture.Mirror.Index!;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string TopicFile => _fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId);

    private IReadOnlyList<string> CompiledResponseEditorIds()
    {
        var result = new PluginCompileService(
                _fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName)),
            GameRelease.Fallout4);
        return [.. ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic)
            .Responses.Select(r => r.EditorID!)];
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

        Assert.Equal("RenamedResponse", Index.At(RecordRef.Effective).GetDocument(_fixture.Response.ToString(), _fixture.Plugin)!.EditorId);
        Assert.Equal(["RenamedResponse", ContainerModFixture.Response2EditorId], CompiledResponseEditorIds());
    }

    [Fact]
    public void DeletingAResponse_RemovesItsElementFromTheTopicDocument_LeavingItsSiblingInPlace_AndCompiles()
    {
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.Response.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(TopicFile);
        Assert.DoesNotContain($"\"{ContainerModFixture.ResponseEditorId}\"", after, StringComparison.Ordinal);
        Assert.Contains($"\"{ContainerModFixture.Response2EditorId}\"", after, StringComparison.Ordinal);
        Assert.Equal([Path.GetFileName(TopicFile)], _fixture.GitStatus().Select(Path.GetFileName));

        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.Response.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.Response.ToString(), _fixture.Plugin));
        var survivor = Assert.Single(Index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.DialogTopic.ToString()));
        Assert.Equal((_fixture.Response2.ToString(), 0), (survivor.ChildFormKey, survivor.SlotIndex));

        Assert.Equal([ContainerModFixture.Response2EditorId], CompiledResponseEditorIds());
    }

    [Fact]
    public void RenumberingAResponse_ChangesItsFormKeyInPlaceInTheTopicDocument_AndCompilesInOrder()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Response.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(TopicFile);
        Assert.Contains(result.NewFormKey!, after, StringComparison.Ordinal);
        Assert.DoesNotContain(_fixture.Response.ToString(), after, StringComparison.Ordinal);
        Assert.Equal([Path.GetFileName(TopicFile)], _fixture.GitStatus().Select(Path.GetFileName));

        Assert.Equal(
            [(result.NewFormKey!, 0), (_fixture.Response2.ToString(), 1)],
            Index.At(RecordRef.Effective).GetContainerChildren(_fixture.Plugin, _fixture.DialogTopic.ToString())
                .OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotIndex)));

        Assert.Equal([ContainerModFixture.ResponseEditorId, ContainerModFixture.Response2EditorId], CompiledResponseEditorIds());
    }

    [Fact]
    public void ARefusedResponseEdit_LeavesTheTopicDocumentAndTheIndexUntouched()
    {
        var before = File.ReadAllText(TopicFile);
        var indexedBefore = Index.At(RecordRef.Effective).GetDocument(_fixture.Response.ToString(), _fixture.Plugin)!.Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(before, File.ReadAllText(TopicFile));
        Assert.Empty(_fixture.GitStatus());
        Assert.Equal(indexedBefore, Index.At(RecordRef.Effective).GetDocument(_fixture.Response.ToString(), _fixture.Plugin)!.Body);
    }

    // The container rule's mint: the destination lacks the topic and the quest, so both land bare
    // and Partial Form, with the response inline in the topic's document.
    [Fact]
    public void CopyingAResponseAsOverride_IntoAPluginLackingItsTopic_MintsABarePartialFormTopicWithTheResponseInline()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = ProjectingEditService.Over(fixture.Mirror);

        var result = service.CopyRecordAsOverride(fixture.SourcePlugin, fixture.Response1.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var reads = fixture.Mirror.Projected();
        Assert.True(reads.GetDocument(fixture.Quest.ToString(), fixture.DestinationPlugin)!.IsPartialForm);
        Assert.True(reads.GetDocument(fixture.DialogTopic.ToString(), fixture.DestinationPlugin)!.IsPartialForm);
        Assert.Equal(
            fixture.Response1.ToString(),
            Assert.Single(reads.GetContainerChildren(fixture.DestinationPlugin, fixture.DialogTopic.ToString())).ChildFormKey);

        var topicFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.Response1EditorId);
        Assert.Contains($"\"FormKey\": \"{fixture.DialogTopic}\"", File.ReadAllText(topicFile), StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(fixture.DestinationSourceRoot, "Responses", SearchOption.AllDirectories));

        var compile = new PluginCompileService(
                fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
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
