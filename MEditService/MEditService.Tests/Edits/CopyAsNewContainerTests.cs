using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #550 AC5 — Copy as New Record widened to the QUST/DIAL/INFO family (#440's ruling: xEdit allows
/// exactly these; CELL/WRLD stay on the permanent blacklist). Each assertion ends at the compiled
/// binary where structure is claimed, per <see cref="ExteriorCellCopyCompileTests"/>'s own argument.
/// </summary>
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

    // AC5's centerpiece: a DIAL with INFOs. The topic and each response draw fresh native FormKeys
    // (ResolveTargetFormKey per child); the destination gets an auto-created bare Partial Form
    // override of the parent quest; and Response2's sibling link at Response1 is NOT remapped onto
    // the copies — it still points at the original (xEdit's own behavior).
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

    // Rule 1 of #550's Q3 resolution: an existing parent override is never touched. With the quest
    // already overridden for real (Copy as Override, not Partial Form), the new topic lands inside
    // that quest's existing directory and the quest's own document keeps its exact bytes and flag.
    [Fact]
    public void CopyAsNewRecord_OnADialogTopic_WhenDestinationAlreadyOverridesTheQuest_ReusesItUntouched()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin).Applied);
        var questFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.QuestEditorId);
        var questBytesBefore = File.ReadAllBytes(questFile);

        var result = service.CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.True(questBytesBefore.AsSpan().SequenceEqual(File.ReadAllBytes(questFile)), "quest document changed bytes");

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        var questDoc = reads.GetDocument(_fixture.Quest.ToString(), _fixture.DestinationPlugin);
        Assert.False(questDoc!.IsPartialForm);

        // One quest directory total; the topic's directory sits inside it.
        var questsDir = Path.Combine(_fixture.DestinationSourceRoot, "Quests");
        var questDir = Assert.Single(Directory.EnumerateDirectories(questsDir));
        Assert.Single(Directory.EnumerateDirectories(Path.Combine(questDir, "DialogTopics")));

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

        var compiledTopic = ImportCompiled().Quests.Single(q => q.FormKey == _fixture.Quest)
            .DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic);
        var compiledResponse = Assert.Single(compiledTopic.Responses);
        Assert.Equal(newFormKey, compiledResponse.FormKey.ToString());
        Assert.Equal(ContainerCopyFixture.Response1EditorId, compiledResponse.EditorID);
    }

    // A Quest copies as its own record only — its folder-split children (DialogTopics) never ride
    // along with a plain Copy as New Record (deep copy is #551's gesture, not this one).
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
