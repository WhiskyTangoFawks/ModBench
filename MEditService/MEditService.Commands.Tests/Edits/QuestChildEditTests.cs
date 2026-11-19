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

    public void Dispose() => _fixture.Dispose();

    private string QuestText => _fixture.Document(_fixture.Quest.ToString()).Require().Body;

    private async Task<IReadOnlyList<IMajorRecordGetter>> CompiledSlot(Func<IQuestGetter, IEnumerable<IMajorRecordGetter>> slot)
    {
        using var compiled = await _fixture.CompiledAsync(_fixture.Plugin);
        return [.. slot(compiled.Quests.Single(q => q.FormKey == _fixture.Quest))];
    }

    private static readonly Dictionary<string, (Func<ContainerModFixture, FormKey> Child, Func<ContainerModFixture, Func<IQuestGetter, IEnumerable<IMajorRecordGetter>>> Slot)> Kinds = new()
    {
        ["topic"] = (f => f.DialogTopic2, _ => q => q.DialogTopics),
        ["branch"] = (f => f.DialogBranch, _ => q => q.DialogBranches),
        ["scene"] = (f => f.Scene, _ => q => q.Scenes),
        ["response"] = (f => f.Response, f => q => q.DialogTopics.Single(t => t.FormKey == f.DialogTopic).Responses),
    };

    public static TheoryData<string> KindNames { get; } = ["topic", "branch", "scene", "response"];

    [Theory]
    [MemberData(nameof(KindNames))]
    public async Task EditingAQuestChildsEditorId_RenamesItsOwnFile_ChangesNoOther_AndCompilesIntoItsContainer(string kind)
    {
        var (child, slot) = Kinds[kind];
        var quest = QuestText;

        var result = _fixture.EditHandler.Set(_fixture.Plugin, child(_fixture).ToString(), "EditorID", Json("\"Renamed\""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_fixture.DocumentFile(child(_fixture).ToString()).Require()], _fixture.ChangedDocumentFiles());
        Assert.Contains("Renamed - ", _fixture.DocumentFile(child(_fixture).ToString()), StringComparison.Ordinal);
        Assert.Equal(quest, QuestText);
        Assert.Contains("Renamed", (await CompiledSlot(slot(_fixture))).Select(record => record.EditorID));
    }

    [Theory]
    [MemberData(nameof(KindNames))]
    public async Task DeletingAQuestChild_DeletesItsOwnFile_LeavesItsContainersUntouched_AndCompilesWithoutIt(string kind)
    {
        var (child, slot) = Kinds[kind];
        var quest = QuestText;

        var result = _fixture.DeleteHandler.DeleteRecordsSync([new RecordAt(_fixture.Plugin, child(_fixture).ToString())]);

        Assert.Empty(result.Refused);
        Assert.Null(_fixture.Document(child(_fixture).ToString()));
        Assert.Equal(quest, QuestText);
        Assert.DoesNotContain(child(_fixture), (await CompiledSlot(slot(_fixture))).Select(record => record.FormKey));
    }

    [Fact]
    public async Task DeletingATopic_DeletesItsResponsesWithIt()
    {
        _ = _fixture.DeleteHandler.DeleteRecordsSync([new RecordAt(_fixture.Plugin, _fixture.DialogTopic.ToString())]);

        Assert.All([_fixture.Response, _fixture.Response2], gone => Assert.Null(_fixture.Document(gone.ToString())));
        Assert.Equal(
            [_fixture.DialogTopic2, _fixture.DialogTopic3],
            (await CompiledSlot(q => q.DialogTopics)).Select(record => record.FormKey).Order());
    }

    [Theory]
    [MemberData(nameof(KindNames))]
    public async Task EditingTheFormIdOfAQuestChild_MovesItsOwnFileToTheNewKey_LeavesItsContainersUntouched_AndCompiles(string kind)
    {
        var (child, slot) = Kinds[kind];
        var quest = QuestText;

        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, child(_fixture).ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        var rekeyed = result.NewFormKey.Require();
        Assert.Null(_fixture.Document(child(_fixture).ToString()));
        Assert.Contains("000F00_", _fixture.DocumentFile(rekeyed), StringComparison.Ordinal);
        Assert.Equal(quest, QuestText);
        Assert.Contains(FormKey.Factory(rekeyed), (await CompiledSlot(slot(_fixture))).Select(record => record.FormKey));
    }

    [Fact]
    public async Task AddingMovingAndRemoving_OnAResponsesOwnArray_PatchOnlyItsFile_AndCompileInOrder()
    {
        var response = _fixture.Response.ToString();
        Assert.Equal(ContainerModFixture.ResponseLineNumbers.Select(l => (int)l), LineNumbersInDocument());

        var added = _fixture.EditHandler.Edit(_fixture.Plugin, response, AddAt(Json("""{"ResponseNumber": 3}"""), Member("Responses")));
        Assert.True(added.Applied, added.Message);
        var moved = _fixture.EditHandler.Edit(_fixture.Plugin, response, MoveTo(0, Member("Responses"), At(2)));
        Assert.True(moved.Applied, moved.Message);
        var removed = _fixture.EditHandler.Edit(_fixture.Plugin, response, RemoveAt(Member("Responses"), At(1)));
        Assert.True(removed.Applied, removed.Message);

        Assert.Equal([3, 2], LineNumbersInDocument());
        Assert.Equal([_fixture.DocumentFile(response).Require()], _fixture.ChangedDocumentFiles());
        Assert.Equal(
            [3, 2],
            ((IDialogResponsesGetter)(await CompiledSlot(q => q.DialogTopics.Single(t => t.FormKey == _fixture.DialogTopic).Responses))
                .Single(r => r.FormKey == _fixture.Response)).Responses.Select(l => (int)l.ResponseNumber));
    }

    [Fact]
    public void ARefusedResponseEdit_AnswersNoChanges()
    {
        var responseBefore = _fixture.Document(_fixture.Response.ToString()).Require().Body;

        var result = _fixture.EditHandler.Set(_fixture.Plugin, _fixture.Response.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Empty(_fixture.ChangedFormKeys());
        Assert.Equal(responseBefore, _fixture.Document(_fixture.Response.ToString()).Require().Body);
    }

    private int[] LineNumbersInDocument() =>
        [.. JsonNode.Parse(_fixture.Document(_fixture.Response.ToString()).Require().Body).Require()[nameof(DialogResponses.Responses)].Require().AsArray()
            .Select(l => l.Require()[nameof(DialogResponse.ResponseNumber)].Require().GetValue<int>())];
}
