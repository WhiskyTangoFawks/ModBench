using System.Collections;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompileEmbeddedListOrderTests : TestInstance
{
    private const string PluginName = "EmbeddedList.esp";
    private const string Origin = "EmbeddedListMod";
    private const string QuestEditorId = "Quest";
    private const string QuestTopics = "a quest's DialogTopics";
    private const string TopicResponses = "a topic's Responses, inside its quest's document";
    private const int EnoughForAReversalToDifferFromTheOriginal = 3;

    public static TheoryData<string> EmbeddedLists => [QuestTopics, TopicResponses];

    private readonly PluginAddress _plugin;
    private readonly FormKey _quest;
    private readonly FormKey _firstTopic;

    public CompileEmbeddedListOrderTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var quest = mod.Quests.AddNew(QuestEditorId);
        foreach (var index in Enumerable.Range(1, EnoughForAReversalToDifferFromTheOriginal))
        {
            var topic = new DialogTopic(mod) { EditorID = $"Topic{index}" };
            foreach (var response in Enumerable.Range(1, EnoughForAReversalToDifferFromTheOriginal))
                topic.Responses.Add(new DialogResponses(mod) { EditorID = $"Topic{index}Response{response}" });
            quest.DialogTopics.Add(topic);
        }

        _quest = quest.FormKey;
        _firstTopic = quest.DialogTopics[0].FormKey;
        _plugin = Add(mod, Origin);
    }

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task Compile_OfASourceWithAnElementRemoved_DropsThatElement(string list)
    {
        var original = ChildrenOf(list);

        await CompileAfter(quest =>
        {
            var items = ListOf(quest, list);
            items.RemoveAt(items.Count - 1);
        });

        Assert.Equal(original.Take(original.Count - 1), ChildrenOf(list));
    }

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task Compile_OfASourceWithTheListReversed_ReversesTheChildren(string list)
    {
        var original = ChildrenOf(list);

        await CompileAfter(quest =>
        {
            var items = ListOf(quest, list);
            var reversed = items.Cast<object>().Reverse().ToList();
            items.Clear();
            foreach (var item in reversed) items.Add(item);
        });

        Assert.Equal(original.AsEnumerable().Reverse(), ChildrenOf(list));
    }

    private IList ListOf(Quest quest, string list) =>
        list == QuestTopics ? quest.DialogTopics : quest.DialogTopics.Single(topic => topic.FormKey == _firstTopic).Responses;

    private async Task CompileAfter(Action<Quest> editTheSource)
    {
        SourceEdits.Rewrite(
            RepositoryOf(_plugin).Require(), _plugin, new RecordIdentity(_quest.ToString(), "qust", QuestEditorId),
            GameRelease.Fallout4, editTheSource);

        var answer = await CompileHandler.CompileAsync([_plugin]);

        Assert.Empty(answer.Refused);
        Assert.Single(answer.Landed);
    }

    private IReadOnlyList<string> ChildrenOf(string list)
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), Path.Combine(FolderOf(Origin), PluginName)), GameRelease.Fallout4);
        var quest = ((IFallout4ModGetter)overlay).Quests.Single();
        return list == QuestTopics
            ? [.. quest.DialogTopics.Select(topic => topic.FormKey.ToString())]
            : [.. quest.DialogTopics.Single(topic => topic.FormKey == _firstTopic).Responses.Select(response => response.FormKey.ToString())];
    }
}
