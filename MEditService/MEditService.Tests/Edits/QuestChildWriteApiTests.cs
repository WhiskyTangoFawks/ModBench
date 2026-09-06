using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>A quest's children live inline in its document, transitively, so every gesture on one
/// patches the quest's document at the edited path only, the index re-derives from it, and compile
/// keeps the document's order.</summary>
public sealed class QuestChildWriteApiTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordIndex Index => _fixture.Mirror.Index!;

    private IRecordReads Reads => Index.At(RecordRef.Effective);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string QuestFile => _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);

    private IQuestGetter CompiledQuest()
    {
        var result = new PluginCompileService(
                _fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName)),
            GameRelease.Fallout4);
        _overlays.Add(overlay);
        return ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == _fixture.Quest);
    }

    private readonly List<IDisposable> _overlays = [];

    private void AssertOnlyTheQuestFileChanged()
    {
        var changed = Assert.Single(_fixture.GitStatus());
        Assert.EndsWith(Path.GetFileName(QuestFile), changed, StringComparison.Ordinal);
    }

    private IReadOnlyList<(string ChildFormKey, int SlotIndex)> QuestSlot(string slotName) =>
        [.. Reads.GetContainerChildren(_fixture.Plugin, _fixture.Quest.ToString())
            .Where(c => c.SlotName == slotName).OrderBy(c => c.SlotIndex).Select(c => (c.ChildFormKey, c.SlotIndex))];

    // ---- set ----

    public static TheoryData<string> QuestChildKinds => ["topic", "branch", "scene"];

    private (FormKey Child, string EditorId, Func<IQuestGetter, IEnumerable<string>> Siblings) Kind(string kind) => kind switch
    {
        "topic" => (_fixture.DialogTopic2, ContainerModFixture.DialogTopic2EditorId, q => q.DialogTopics.Select(t => t.EditorID!)),
        "branch" => (_fixture.DialogBranch, ContainerModFixture.DialogBranchEditorId, q => q.DialogBranches.Select(b => b.EditorID!)),
        "scene" => (_fixture.Scene, ContainerModFixture.SceneEditorId, q => q.Scenes.Select(s => s.EditorID!)),
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "No such quest child kind."),
    };

    [Theory]
    [MemberData(nameof(QuestChildKinds))]
    public void SettingAQuestChildsField_ChangesTheQuestDocumentAtThatPathAndNowhereElse_AndCompilesInOrder(string kind)
    {
        var (child, editorId, siblings) = Kind(kind);
        var before = File.ReadAllText(QuestFile);
        Assert.Empty(_fixture.GitStatus());

        var result = EditService().Set(_fixture.Plugin, child.ToString(), "EditorID", Json($"\"Renamed{kind}\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace($"\"EditorID\": \"{editorId}\"", $"\"EditorID\": \"Renamed{kind}\"", StringComparison.Ordinal),
            File.ReadAllText(QuestFile));
        AssertOnlyTheQuestFileChanged();

        Assert.Equal($"Renamed{kind}", Reads.GetDocument(child.ToString(), _fixture.Plugin)!.EditorId);
        var compiled = siblings(CompiledQuest()).ToList();
        Assert.Contains($"Renamed{kind}", compiled);
        if (kind == "topic")
        {
            Assert.Equal(
                [ContainerModFixture.DialogTopicEditorId, "Renamedtopic", ContainerModFixture.DialogTopic3EditorId], compiled);
        }
    }

    // The nesting's deepest level: a response inside a topic inside the quest.
    [Fact]
    public void RenamingANestedResponse_ChangesTheQuestDocumentAtTheResponsesElementOnly_AndCompilesInOrder()
    {
        var before = File.ReadAllText(QuestFile);

        var result = EditService().Set(_fixture.Plugin, _fixture.Response.ToString(), "EditorID", Json("\"RenamedResponse\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace($"\"EditorID\": \"{ContainerModFixture.ResponseEditorId}\"", "\"EditorID\": \"RenamedResponse\"", StringComparison.Ordinal),
            File.ReadAllText(QuestFile));
        AssertOnlyTheQuestFileChanged();

        Assert.Equal("RenamedResponse", Reads.GetDocument(_fixture.Response.ToString(), _fixture.Plugin)!.EditorId);
        Assert.Equal(_fixture.DialogTopic.ToString(), Reads.GetContainerParent(_fixture.Plugin, _fixture.Response.ToString())!.Value.ParentFormKey);
        Assert.Equal(
            ["RenamedResponse", ContainerModFixture.Response2EditorId],
            CompiledQuest().DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic).Responses.Select(r => r.EditorID!));
    }

    // ---- the generic array ops, on an embedded child's own array field ----

    [Fact]
    public void AddingMovingAndRemoving_OnANestedResponsesOwnArray_PatchTheQuestDocumentAtThatArray_AndCompileInOrder()
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

        AssertOnlyTheQuestFileChanged();
        // The sibling response and the other children are untouched by the three edits.
        Assert.Contains($"\"{ContainerModFixture.Response2EditorId}\"", File.ReadAllText(QuestFile), StringComparison.Ordinal);
        Assert.Equal(
            [3, 2],
            CompiledQuest().DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic)
                .Responses.Single(r => r.FormKey == _fixture.Response).Responses.Select(l => (int)l.ResponseNumber));
    }

    private int[] LineNumbersInDocument()
    {
        var root = JsonNode.Parse(File.ReadAllText(QuestFile))!.AsObject();
        var response = root[nameof(Quest.DialogTopics)]!.AsArray()
            .SelectMany(t => t![nameof(DialogTopic.Responses)] as JsonArray ?? [])
            .Single(r => r![nameof(IMajorRecordGetter.FormKey)]!.GetValue<string>() == _fixture.Response.ToString())!;
        return [.. response[nameof(DialogResponses.Responses)]!.AsArray().Select(l => l![nameof(DialogResponse.ResponseNumber)]!.GetValue<int>())];
    }

    // ---- delete ----

    [Fact]
    public void DeletingATopic_RemovesItAndItsResponsesFromTheQuestDocument_LeavingItsSiblingsInPlace_AndCompiles()
    {
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.DialogTopic.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(QuestFile);
        foreach (var gone in new[] { ContainerModFixture.DialogTopicEditorId, ContainerModFixture.ResponseEditorId, ContainerModFixture.Response2EditorId })
            Assert.DoesNotContain($"\"{gone}\"", after, StringComparison.Ordinal);
        foreach (var kept in new[] { ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId, ContainerModFixture.DialogBranchEditorId, ContainerModFixture.SceneEditorId })
            Assert.Contains($"\"{kept}\"", after, StringComparison.Ordinal);
        AssertOnlyTheQuestFileChanged();

        foreach (var gone in new[] { _fixture.DialogTopic, _fixture.Response, _fixture.Response2 })
        {
            Assert.Null(Reads.GetDocument(gone.ToString(), _fixture.Plugin));
            Assert.NotNull(Index.At(RecordRef.Head).GetDocument(gone.ToString(), _fixture.Plugin));
        }
        Assert.Equal([(_fixture.DialogTopic2.ToString(), 0), (_fixture.DialogTopic3.ToString(), 1)], QuestSlot(nameof(Quest.DialogTopics)));

        var compiled = CompiledQuest();
        Assert.Equal([ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId], compiled.DialogTopics.Select(t => t.EditorID!));
        Assert.Equal([ContainerModFixture.SceneEditorId], compiled.Scenes.Select(s => s.EditorID!));
    }

    // ---- renumber ----

    [Fact]
    public void RenumberingAMidListTopic_ChangesItsFormKeyInPlaceInTheQuestDocument_AndCompilesInOrder()
    {
        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(QuestFile);
        Assert.Contains(result.NewFormKey!, after, StringComparison.Ordinal);
        Assert.DoesNotContain(_fixture.DialogTopic2.ToString(), after, StringComparison.Ordinal);
        AssertOnlyTheQuestFileChanged();

        Assert.Equal(
            [(_fixture.DialogTopic.ToString(), 0), (result.NewFormKey!, 1), (_fixture.DialogTopic3.ToString(), 2)],
            QuestSlot(nameof(Quest.DialogTopics)));

        Assert.Equal(
            [ContainerModFixture.DialogTopicEditorId, ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId],
            CompiledQuest().DialogTopics.Select(t => t.EditorID!));
    }

    // ---- refusal ----

    [Fact]
    public void ARefusedQuestChildEdit_LeavesTheQuestDocumentAndTheIndexUntouched()
    {
        var before = File.ReadAllText(QuestFile);
        var indexedBefore = Reads.GetDocument(_fixture.Scene.ToString(), _fixture.Plugin)!.Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.Scene.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(before, File.ReadAllText(QuestFile));
        Assert.Empty(_fixture.GitStatus());
        Assert.Equal(indexedBefore, Reads.GetDocument(_fixture.Scene.ToString(), _fixture.Plugin)!.Body);
    }

    // ---- copy as override: the container rule's mint, one and two levels up ----

    [Fact]
    public void CopyingASceneAsOverride_IntoAPluginLackingItsQuest_MintsABarePartialFormQuestWithTheSceneInline()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = new RecordEditService(fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.CopyRecordAsOverride(fixture.SourcePlugin, fixture.Scene.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var reads = fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.True(reads.GetDocument(fixture.Quest.ToString(), fixture.DestinationPlugin)!.IsPartialForm);
        Assert.Equal(
            fixture.Scene.ToString(),
            Assert.Single(reads.GetContainerChildren(fixture.DestinationPlugin, fixture.Quest.ToString())).ChildFormKey);

        var questFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.SceneEditorId);
        Assert.Equal("Quests", Path.GetFileName(Path.GetDirectoryName(questFile)));
        Assert.Contains($"\"FormKey\": \"{fixture.Quest}\"", File.ReadAllText(questFile), StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(Path.Combine(fixture.DestinationSourceRoot, "Quests")));

        var compiled = CompileAndImport(fixture).Quests.Single(q => q.FormKey == fixture.Quest);
        Assert.Equal(ContainerCopyFixture.SceneEditorId, Assert.Single(compiled.Scenes).EditorID);
        Assert.Empty(compiled.DialogTopics);
    }

    // Own fields only, like every plain copy: the topic lands with no responses.
    [Fact]
    public void CopyingATopicAsOverride_IntoAPluginLackingItsQuest_MintsTheQuest_AndLandsTheTopicWithEmptyResponses()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = new RecordEditService(fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.CopyRecordAsOverride(fixture.SourcePlugin, fixture.DialogTopic.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var reads = fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.True(reads.GetDocument(fixture.Quest.ToString(), fixture.DestinationPlugin)!.IsPartialForm);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, reads.GetDocument(fixture.DialogTopic.ToString(), fixture.DestinationPlugin)!.EditorId);
        Assert.Null(reads.GetDocument(fixture.Response1.ToString(), fixture.DestinationPlugin));
        Assert.Empty(reads.GetContainerChildren(fixture.DestinationPlugin, fixture.DialogTopic.ToString()));

        var compiledTopic = Assert.Single(CompileAndImport(fixture).Quests.Single(q => q.FormKey == fixture.Quest).DialogTopics);
        Assert.Equal(ContainerCopyFixture.DialogTopicEditorId, compiledTopic.EditorID);
        Assert.Empty(compiledTopic.Responses);
    }

    // A response into a plugin holding neither its topic nor its quest: both minted, one document.
    [Fact]
    public void CopyingAResponseAsOverride_IntoAPluginLackingItsTopicAndQuest_MintsBoth_InOneQuestDocument()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = new RecordEditService(fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.CopyRecordAsOverride(fixture.SourcePlugin, fixture.Response2.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var reads = fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.True(reads.GetDocument(fixture.Quest.ToString(), fixture.DestinationPlugin)!.IsPartialForm);
        Assert.True(reads.GetDocument(fixture.DialogTopic.ToString(), fixture.DestinationPlugin)!.IsPartialForm);
        Assert.Equal(fixture.DialogTopic.ToString(), Assert.Single(reads.GetContainerChildren(fixture.DestinationPlugin, fixture.Quest.ToString())).ChildFormKey);
        Assert.Equal(fixture.Response2.ToString(), Assert.Single(reads.GetContainerChildren(fixture.DestinationPlugin, fixture.DialogTopic.ToString())).ChildFormKey);

        var questsFolder = Path.Combine(fixture.DestinationSourceRoot, "Quests");
        Assert.Single(Directory.EnumerateFiles(questsFolder), f => Path.GetFileName(f) != "GroupRecordData.json");
        Assert.Empty(Directory.EnumerateDirectories(questsFolder));

        var compiledTopic = Assert.Single(CompileAndImport(fixture).Quests.Single(q => q.FormKey == fixture.Quest).DialogTopics);
        Assert.Equal(ContainerCopyFixture.Response2EditorId, Assert.Single(compiledTopic.Responses).EditorID);
    }

    private IFallout4ModGetter CompileAndImport(ContainerCopyFixture fixture)
    {
        var compile = new PluginCompileService(
                fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
            .Compile(fixture.DestinationPlugin, new CompileSource.WorkingTree());
        Assert.True(compile.Succeeded, compile.RefusalReason);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerCopyFixture.DestinationPluginName), Path.Combine(fixture.DestinationModFolder, ContainerCopyFixture.DestinationPluginName)),
            GameRelease.Fallout4);
        _overlays.Add(overlay);
        return (IFallout4ModGetter)overlay;
    }
}
