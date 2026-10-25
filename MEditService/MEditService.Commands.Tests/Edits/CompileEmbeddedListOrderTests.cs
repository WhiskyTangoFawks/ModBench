using System.Collections;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompileEmbeddedListOrderTests : TestInstance
{
    private const string QuestEditorId = "Quest";

    public static TheoryData<string, Func<Quest, IList>, Func<IQuestGetter, IEnumerable<FormKey>>> EmbeddedLists => new()
    {
        { "a quest's DialogTopics", quest => quest.DialogTopics, quest => quest.DialogTopics.Select(topic => topic.FormKey) },
        {
            "a topic's Responses, inside its quest's document",
            quest => quest.DialogTopics[0].Responses,
            quest => quest.DialogTopics[0].Responses.Select(response => response.FormKey)
        },
    };

    private readonly PluginAddress _plugin;
    private readonly FormKey _quest;

    public CompileEmbeddedListOrderTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("EmbeddedList.esp"), Fallout4Release.Fallout4);
        var quest = mod.Quests.AddNew(QuestEditorId);
        quest.DialogTopics.AddRange([Topic(mod, "Topic1"), Topic(mod, "Topic2"), Topic(mod, "Topic3")]);
        _quest = quest.FormKey;
        _plugin = Add(mod, "EmbeddedListMod");
    }

    private static DialogTopic Topic(Fallout4Mod mod, string editorId)
    {
        var topic = new DialogTopic(mod) { EditorID = editorId };
        topic.Responses.AddRange([
            new DialogResponses(mod) { EditorID = $"{editorId}Response1" },
            new DialogResponses(mod) { EditorID = $"{editorId}Response2" },
            new DialogResponses(mod) { EditorID = $"{editorId}Response3" },
        ]);
        return topic;
    }

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task Compile_OfASourceWithTheMiddleElementRemoved_KeepsTheOthersInOrder(
        string _, Func<Quest, IList> sourceList, Func<IQuestGetter, IEnumerable<FormKey>> compiledList)
    {
        var original = ChildrenIn(this.Binary(_plugin), compiledList);

        var compiled = await ChildrenAfter(quest => sourceList(quest).RemoveAt(1), compiledList);

        Assert.Equal([original[0], original[2]], compiled);
    }

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task Compile_OfASourceWithTheFirstAndLastElementsSwapped_SwapsTheChildren(
        string _, Func<Quest, IList> sourceList, Func<IQuestGetter, IEnumerable<FormKey>> compiledList)
    {
        var original = ChildrenIn(this.Binary(_plugin), compiledList);

        var compiled = await ChildrenAfter(
            quest =>
            {
                var items = sourceList(quest);
                (items[0], items[2]) = (items[2], items[0]);
            },
            compiledList);

        Assert.Equal([original[2], original[1], original[0]], compiled);
    }

    private static IReadOnlyList<FormKey> ChildrenIn(IFallout4ModDisposableGetter binary, Func<IQuestGetter, IEnumerable<FormKey>> compiledList)
    {
        using (binary) return [.. compiledList(binary.Quests.Single())];
    }

    private async Task<IReadOnlyList<FormKey>> ChildrenAfter(Action<Quest> editTheSource, Func<IQuestGetter, IEnumerable<FormKey>> compiledList)
    {
        SourceEdits.Rewrite(
            RepositoryOf(_plugin).Require(), _plugin, new RecordIdentity(_quest.ToString(), "qust", QuestEditorId),
            GameRelease.Fallout4, editTheSource);
        return ChildrenIn(await this.CompiledAsync(_plugin), compiledList);
    }
}
