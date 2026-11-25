using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsNewContainerTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private IReadOnlyList<JsonElement> Responses(string topicFormKey) => Held(topicFormKey, nameof(DialogTopic.Responses));

    private IReadOnlyList<JsonElement> Held(string containerFormKey, string slot)
    {
        var container = SourceModTree.DocumentFile(_fixture.DestinationModFolder, _fixture.DestinationPlugin, containerFormKey).Require();
        var folder = Path.Combine(_fixture.DestinationModFolder, Path.GetDirectoryName(container).Require(), slot);
        return Directory.Exists(folder)
            ? [.. Directory.EnumerateFiles(folder, "*.json", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
                .Select(file => JsonDocument.Parse(File.ReadAllText(file)).RootElement)]
            : [];
    }

    private static string Member(JsonElement response, string name) => response.GetProperty(name).GetString().Require();

    [Fact]
    public void CopyAsNewRecord_OnAResponseLinkingItsSibling_LeavesTheLinkAtTheOriginal()
    {
        var result = _fixture.CopyHandler.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Response2.ToString())], CopyMode.New, [_fixture.DestinationPlugin], replace: false);

        result.OnlyLanded();
        var landed = Assert.Single(Responses(_fixture.DialogTopic.ToString()));
        Assert.Equal(_fixture.Response1.ToString(), Member(landed, "PreviousDialog"));
    }

    [Fact]
    public void CopyAsNewRecord_OnAQuest_LandsANewQuestUnderAFreshFormKey_WithoutItsTopics()
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
    }
}
