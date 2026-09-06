using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
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

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IFallout4ModGetter ImportCompiled()
    {
        var compileResult = new PluginCompileService(
                _fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
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

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);

        // The parent chain: quest auto-created as a bare Partial Form override, same FormKey as the
        // source quest (it is an override, not a copy).
        var questDoc = reads.GetDocument(_fixture.Quest.ToString(), _fixture.DestinationPlugin);
        Assert.NotNull(questDoc);
        Assert.True(questDoc!.IsPartialForm);

        // The topic's children in the index: two responses, fresh keys, source order preserved.
        var children = reads.GetContainerChildren(_fixture.DestinationPlugin, newTopicFormKey);
        Assert.Equal(2, children.Count);
        var childDocs = children
            .OrderBy(c => c.SlotIndex)
            .Select(c => reads.GetDocument(c.ChildFormKey, _fixture.DestinationPlugin)!)
            .ToList();
        Assert.Equal(
            [ContainerCopyFixture.Response1EditorId, ContainerCopyFixture.Response2EditorId],
            childDocs.Select(d => d.EditorId!).ToArray());
        Assert.All(children, c =>
            Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, c.ChildFormKey, StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(_fixture.Response1.ToString(), children.Select(c => c.ChildFormKey));
        Assert.DoesNotContain(_fixture.Response2.ToString(), children.Select(c => c.ChildFormKey));

        // Compiled: the quest carries the new topic; the topic carries both responses under their
        // new keys in order; the copied Response2 still links the ORIGINAL Response1.
        // Both responses are inline in the new topic's one document.
        var topicText = File.ReadAllText(_fixture.DestinationSourceFileContaining(ContainerCopyFixture.DialogTopicEditorId));
        Assert.All(children, c => Assert.Contains(c.ChildFormKey, topicText, StringComparison.Ordinal));
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

    // An existing parent override is never touched: the new topic lands inside the quest's existing
    // directory and the quest's document keeps its bytes and flag.
    [Fact]
    public void CopyAsNewRecord_OnADialogTopic_WhenDestinationAlreadyOverridesTheQuest_ReusesItUntouched()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin).Applied);
        var questFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.QuestEditorId);
        var questBefore = JsonDocument.Parse(File.ReadAllText(questFile));

        var result = service.CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        // "Untouched" means the quest's own fields, not its file: a parent's document is where its
        // children's order lives (ADR-0042 decision 4), so exactly one thing may differ.
        var questAfter = JsonDocument.Parse(File.ReadAllText(questFile));
        foreach (var property in questBefore.RootElement.EnumerateObject())
        {
            if (property.NameEquals("MEditChildOrder")) continue;
            Assert.True(
                questAfter.RootElement.TryGetProperty(property.Name, out var now),
                $"quest document lost '{property.Name}'");
            Assert.Equal(property.Value.GetRawText(), now.GetRawText());
        }
        Assert.Equal(
            questBefore.RootElement.EnumerateObject().Count(),
            questAfter.RootElement.EnumerateObject().Count(p => !p.NameEquals("MEditChildOrder"))
                + (questBefore.RootElement.TryGetProperty("MEditChildOrder", out _) ? 1 : 0));

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        var questDoc = reads.GetDocument(_fixture.Quest.ToString(), _fixture.DestinationPlugin);
        Assert.False(questDoc!.IsPartialForm);

        // One quest directory total; the topic's file sits inside it.
        var questsDir = Path.Combine(_fixture.DestinationSourceRoot, "Quests");
        var questDir = Assert.Single(Directory.EnumerateDirectories(questsDir));
        Assert.Single(Directory.EnumerateFiles(Path.Combine(questDir, "DialogTopics")));

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

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.True(reads.GetDocument(_fixture.Quest.ToString(), _fixture.DestinationPlugin)!.IsPartialForm);
        Assert.True(reads.GetDocument(_fixture.DialogTopic.ToString(), _fixture.DestinationPlugin)!.IsPartialForm);

        var children = reads.GetContainerChildren(_fixture.DestinationPlugin, _fixture.DialogTopic.ToString());
        var childRow = Assert.Single(children);
        Assert.Equal(newFormKey, childRow.ChildFormKey);

        // Inline in the minted topic's document, which is the only file the response is in.
        Assert.Contains(newFormKey, File.ReadAllText(_fixture.DestinationSourceFileContaining(ContainerCopyFixture.Response1EditorId)), StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(_fixture.DestinationSourceRoot, "Responses", SearchOption.AllDirectories));

        var compiledTopic = ImportCompiled().Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic);
        var compiledResponse = Assert.Single(compiledTopic.Responses);
        Assert.Equal(newFormKey, compiledResponse.FormKey.ToString());
        Assert.Equal(ContainerCopyFixture.Response1EditorId, compiledResponse.EditorID);
    }

    // A Quest copies as its own record only — its folder-split children (DialogTopics) never ride
    // along with a plain Copy as New Record (deep copy is a separate operation).
    [Fact]
    public void CopyAsNewRecord_OnAQuest_LandsANewQuestUnderAFreshFormKey_WithoutItsTopics()
    {
        var result = EditService().CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;
        Assert.EndsWith(ContainerCopyFixture.DestinationPluginName, newFormKey, StringComparison.OrdinalIgnoreCase);

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        var doc = reads.GetDocument(newFormKey, _fixture.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, doc!.EditorId);

        var compiledQuest = ImportCompiled().Quests.Single(q => q.FormKey.ToString() == newFormKey);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, compiledQuest.EditorID);
        Assert.Empty(compiledQuest.DialogTopics);
    }
}
