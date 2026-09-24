using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>An embedded list is an array of its container's document, so a hand edit of it is
/// ordinary: a removed element is a deletion and the array's order is the game's.</summary>
public sealed class HandEditedEmbeddedListTests : IDisposable
{
    private const string PluginName = "EmbeddedList.esp";
    private const string QuestTopics = "a quest's DialogTopics";
    private const string TopicResponses = "a topic's Responses, inside its quest's document";

    private static readonly GameRelease Release = GameRelease.Fallout4;

    public static TheoryData<string> EmbeddedLists => [QuestTopics, TopicResponses];

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-hand-edited-list-").FullName;
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
    private readonly Quest _quest;
    private readonly string _questPath;

    // Three of each, because a reversal of three or more cannot coincide with the original.
    public HandEditedEmbeddedListTests()
    {
        _quest = new Quest(_mod) { EditorID = "Quest" };
        foreach (var index in Enumerable.Range(1, 3))
        {
            var topic = new DialogTopic(_mod) { EditorID = $"Topic{index}" };
            foreach (var response in Enumerable.Range(1, 3))
                topic.Responses.Add(new DialogResponses(_mod) { EditorID = $"Topic{index}Response{response}" });
            _quest.DialogTopics.Add(topic);
        }

        _questPath = Path.Combine(
            SourceRepository.RootFor(PluginName), "Quests",
            $"{_quest.EditorID} - {_quest.FormKey.ID:X6}_{_quest.FormKey.ModKey.FileName}.json");

        PluginBaselines.Track(
            _modFolder,
            SourcePreset.Edits,
            [
                new TreeFile(SourceRepository.HeaderDocumentFor(PluginName), HeaderDocument.Write(_mod)),
                new TreeFile(_questPath, _codec.SerializeToBytes(_quest, Release)),
            ]);
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private string SourceRoot => Path.Combine(_modFolder, SourceRepository.RootFor(PluginName));

    private string QuestFile => Path.Combine(_modFolder, _questPath);

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task AnElementRemovedByHand_ReadsAsADeletion(string list)
    {
        var children = ChildrenOf(list);
        var removed = children[^1];

        Rewrite(list, children.Take(children.Count - 1).ToList());

        var readBack = await ReadBack(list);
        Assert.Equal(children.Take(children.Count - 1), readBack);
        Assert.DoesNotContain(removed, readBack);
    }

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task ReversingTheArray_ReversesTheChildrenItReadsBack(string list)
    {
        var children = ChildrenOf(list);
        Assert.Equal(children, await ReadBack(list));

        Rewrite(list, children.AsEnumerable().Reverse().ToList());

        Assert.Equal(children.AsEnumerable().Reverse(), await ReadBack(list));
    }

    // The owner of the array under test: the quest itself for its topics, its first topic for that
    // topic's responses.
    private string Owner(string list) => list switch
    {
        QuestTopics => _quest.FormKey.ToString(),
        TopicResponses => _quest.DialogTopics[0].FormKey.ToString(),
        _ => throw new ArgumentOutOfRangeException(nameof(list), list, "No such embedded list."),
    };

    private IReadOnlyList<string> ChildrenOf(string list) => list == QuestTopics
        ? [.. _quest.DialogTopics.Select(topic => topic.FormKey.ToString())]
        : [.. _quest.DialogTopics[0].Responses.Select(response => response.FormKey.ToString())];

    private static string MemberName(string list) =>
        list == QuestTopics ? nameof(Quest.DialogTopics) : nameof(DialogTopic.Responses);

    private JsonArray ArrayOf(JsonObject root, string list)
    {
        var topics = root[nameof(Quest.DialogTopics)] as JsonArray
            ?? throw new InvalidOperationException("Expected the quest's document to carry DialogTopics.");
        if (list == QuestTopics) return topics;

        var owner = Owner(list);
        return topics.OfType<JsonNode>().Select(topic => topic.AsObject())
                .Single(topic => FormKeyOf(topic) == owner)[nameof(DialogTopic.Responses)] as JsonArray
            ?? throw new InvalidOperationException($"Expected topic '{owner}' to carry Responses.");
    }

    private static string FormKeyOf(JsonNode node) =>
        (node[nameof(IMajorRecordGetter.FormKey)]
            ?? throw new InvalidOperationException("Expected node to have a FormKey member.")).GetValue<string>();

    // Reorders and drops elements of the array by identity; every element's own text is untouched.
    private void Rewrite(string list, IReadOnlyList<string> order)
    {
        var root = (JsonNode.Parse(File.ReadAllText(QuestFile))
            ?? throw new InvalidOperationException("Expected the quest's document to parse as a JSON node.")).AsObject();
        var array = ArrayOf(root, list);
        var byFormKey = array.OfType<JsonNode>().ToDictionary(FormKeyOf, element => element.DeepClone());
        var holder = (array.Parent ?? throw new InvalidOperationException("Expected the array to have a parent JSON object.")).AsObject();
        holder[MemberName(list)] = new JsonArray([.. order.Select(formKey => byFormKey[formKey])]);
        File.WriteAllText(QuestFile, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private async Task<IReadOnlyList<string>> ReadBack(string list)
    {
        var mod = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            SourceRoot, InlineWorkDropoff.Instance, CancellationToken.None);
        var quests = ((IFallout4ModGetter)mod).Quests;
        var owner = Owner(list);
        return list == QuestTopics
            ? [.. quests.Single(q => q.FormKey.ToString() == owner).DialogTopics.Select(t => t.FormKey.ToString())]
            : [.. quests.SelectMany(q => q.DialogTopics).Single(t => t.FormKey.ToString() == owner).Responses.Select(r => r.FormKey.ToString())];
    }
}
