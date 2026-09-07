using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Copy as New Record covers the QUST/DIAL/INFO family (xEdit allows exactly these;
/// CELL/WRLD stay on the permanent blacklist).</summary>
public sealed class CopyAsNewContainerTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose()
    {
        foreach (var overlay in _overlays) overlay.Dispose();
        _fixture.Dispose();
    }

    private readonly List<IDisposable> _overlays = [];

    private RecordEditService EditService() => _fixture.Edits;

    // Every response the destination's copy of a topic carries, in slot order, out of the topic's own
    // document — the only place they exist, since a response has no file of its own.
    private IReadOnlyList<JsonElement> Responses(string topicFormKey)
    {
        var topic = _fixture.Document(_fixture.DestinationPlugin, topicFormKey);
        Assert.NotNull(topic);
        return [.. JsonDocument.Parse(topic!.Body).RootElement.GetProperty("Responses").EnumerateArray()];
    }

    private static string Member(JsonElement response, string name) => response.GetProperty(name).GetString()!;

    private IFallout4ModGetter ImportCompiled()
    {
        var compileResult = CompileServices.Over(_fixture.LoadOrder)
            .Compile(_fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

        var pluginPath = Path.Combine(_fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), pluginPath), GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }

    // The topic and each response draw fresh native FormKeys and the destination gets an auto-created
    // bare Partial Form override of the parent quest. Response2's sibling link still points at the
    // original, which is xEdit's own behavior.
    [Fact]
    public void CopyAsNewRecord_OnADialogTopicWithResponses_MintsFreshKeysForEach_WithoutRemappingSiblingLinks()
    {
        var result = EditService().CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var newTopicFormKey = result.NewFormKey!;
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newTopicFormKey, StringComparison.OrdinalIgnoreCase);

        // The parent chain: quest auto-created as a bare Partial Form override, same FormKey as the
        // source quest (it is an override, not a copy).
        var quest = _fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString());
        Assert.NotNull(quest);
        Assert.True(quest!.IsPartialForm());

        // The new topic's own document carries both responses, fresh keys, source order preserved.
        var responses = Responses(newTopicFormKey);
        Assert.Equal(2, responses.Count);
        Assert.Equal(
            [ContainerCopyFixture.Response1EditorId, ContainerCopyFixture.Response2EditorId],
            responses.Select(r => Member(r, "EditorID")).ToArray());
        Assert.All(responses, r =>
            Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, Member(r, "FormKey"), StringComparison.OrdinalIgnoreCase));
        var responseKeys = responses.Select(r => Member(r, "FormKey")).ToList();
        Assert.DoesNotContain(_fixture.Response1.ToString(), responseKeys);
        Assert.DoesNotContain(_fixture.Response2.ToString(), responseKeys);

        // Compiled: the quest carries the new topic; the topic carries both responses under their
        // new keys in order; the copied Response2 still links the ORIGINAL Response1.
        // Both responses are inline in the new topic's one document.
        var topicText = File.ReadAllText(_fixture.DestinationSourceFileContaining(ContainerCopyFixture.DialogTopicEditorId));
        Assert.All(responseKeys, key => Assert.Contains(key, topicText, StringComparison.Ordinal));
        Assert.Empty(Directory.EnumerateDirectories(_fixture.DestinationSourceRoot, "Responses", SearchOption.AllDirectories));

        var compiled = ImportCompiled();
        var compiledQuest = compiled.Quests.Single(q => q.FormKey == _fixture.Quest);
        var compiledTopic = compiledQuest.DialogTopics.Single(t => t.FormKey.ToString() == newTopicFormKey);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, compiledTopic.EditorID);
        Assert.Equal(
            [ContainerCopyFixture.Response1EditorId, ContainerCopyFixture.Response2EditorId],
            compiledTopic.Responses.Select(r => r.EditorID!).ToArray());
        var copiedResponse2 = compiledTopic.Responses.Single(r => r.EditorID == ContainerCopyFixture.Response2EditorId);
        Assert.Equal(_fixture.Response1, copiedResponse2.PreviousDialog.FormKeyNullable);
    }

    // An existing parent override keeps its own fields and flag: the new topic lands in its
    // DialogTopics slot and nothing else in the document changes.
    [Fact]
    public void CopyAsNewRecord_OnADialogTopic_WhenDestinationAlreadyOverridesTheQuest_AddsToItsDialogTopicsAndNothingElse()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin).Applied);
        var questFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.QuestEditorId);
        var questBefore = JsonDocument.Parse(File.ReadAllText(questFile));

        var result = service.CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        // The plain override landed with empty child lists, so the slot is new; every other member
        // is byte-for-byte what it was.
        Assert.False(questBefore.RootElement.TryGetProperty(nameof(Quest.DialogTopics), out _));
        var questAfter = JsonDocument.Parse(File.ReadAllText(questFile));
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

        Assert.False(_fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString())!.IsPartialForm());

        // One quest file total, and no directory: the topic is inside it.
        var questsDir = Path.Combine(_fixture.DestinationSourceRoot, "Quests");
        Assert.Empty(Directory.EnumerateDirectories(questsDir));
        Assert.Single(Directory.EnumerateFiles(questsDir), f => Path.GetFileName(f) != "GroupRecordData.json");

        var compiledQuest = ImportCompiled().Quests.Single(q => q.FormKey == _fixture.Quest);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, compiledQuest.EditorID);
        Assert.Single(compiledQuest.DialogTopics, t => t.FormKey.ToString() == result.NewFormKey);
    }

    // An INFO copied alone: the whole missing parent chain (quest, then topic) auto-creates as bare
    // Partial Form overrides — both under their ORIGINAL FormKeys (they are overrides); only the
    // response itself draws a fresh key.
    [Fact]
    public void CopyAsNewRecord_OnAResponseAlone_AutoCreatesTheQuestAndTopicChain()
    {
        var result = EditService().CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.Response1.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        Assert.True(_fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString())!.IsPartialForm());
        Assert.True(_fixture.Document(_fixture.DestinationPlugin, _fixture.DialogTopic.ToString())!.IsPartialForm());

        var landed = Assert.Single(Responses(_fixture.DialogTopic.ToString()));
        Assert.Equal(newFormKey, Member(landed, "FormKey"));

        // Inline in the minted topic's document, which is the only file the response is in.
        Assert.Contains(newFormKey, File.ReadAllText(_fixture.DestinationSourceFileContaining(ContainerCopyFixture.Response1EditorId)), StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(_fixture.DestinationSourceRoot, "Responses", SearchOption.AllDirectories));

        var compiledTopic = ImportCompiled().Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic);
        var compiledResponse = Assert.Single(compiledTopic.Responses);
        Assert.Equal(newFormKey, compiledResponse.FormKey.ToString());
        Assert.Equal(ContainerCopyFixture.Response1EditorId, compiledResponse.EditorID);
    }

    // A Quest copies as its own record only — its children never ride along with a plain Copy as
    // New Record (deep copy is a separate operation).
    [Fact]
    public void CopyAsNewRecord_OnAQuest_LandsANewQuestUnderAFreshFormKey_WithoutItsTopics()
    {
        var result = EditService().CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        var document = _fixture.Document(_fixture.DestinationPlugin, newFormKey);
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, document!.EditorId);

        // Empty child lists in the document itself, not just in the binary.
        var questText = File.ReadAllText(_fixture.DestinationSourceFileContaining(ContainerCopyFixture.QuestEditorId));
        Assert.DoesNotContain(ContainerCopyFixture.DialogTopicEditorId, questText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.SceneEditorId, questText, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.DialogBranchEditorId, questText, StringComparison.Ordinal);

        var compiledQuest = ImportCompiled().Quests.Single(q => q.FormKey.ToString() == newFormKey);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, compiledQuest.EditorID);
        Assert.Empty(compiledQuest.DialogTopics);
        Assert.Empty(compiledQuest.DialogBranches);
        Assert.Empty(compiledQuest.Scenes);
    }
}
