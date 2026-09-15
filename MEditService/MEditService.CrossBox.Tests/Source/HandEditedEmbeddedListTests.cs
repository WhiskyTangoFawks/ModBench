using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.Tests.RealData;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Tests.Source;

/// <summary>An embedded list is an array of its container's document, so a hand edit of it is
/// ordinary: a removed element is a deletion and the array's order is the game's.</summary>
public sealed class HandEditedEmbeddedListTests(CompileRoundTripGateFixture fixture)
    : IClassFixture<CompileRoundTripGateFixture>
{
    public static TheoryData<string> EmbeddedLists => [QuestTopics, TopicResponses];

    private const string QuestTopics = "a quest's DialogTopics";
    private const string TopicResponses = "a topic's Responses, inside its quest's document";

    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task AnElementRemovedByHand_ReadsAsADeletion(string list)
    {
        var (modFolder, sourceRoot) = CopyOfTrackedTemplate();
        try
        {
            var (document, owner, children) = ListWith(sourceRoot, list, atLeast: 2);
            var removed = children[^1];
            Rewrite(document, list, owner, children.Take(children.Count - 1).ToList());

            var readBack = await ReadBack(sourceRoot, list, owner);

            Assert.Equal(children.Take(children.Count - 1), readBack);
            Assert.DoesNotContain(removed, readBack);
        }
        finally
        {
            CompileRoundTripGateFixture.TryDelete(modFolder);
        }
    }

    // Reversed rather than shuffled: a reversal of three or more cannot coincide with the original.
    [Theory]
    [MemberData(nameof(EmbeddedLists))]
    public async Task ReversingTheArray_ReversesTheChildrenItReadsBack(string list)
    {
        var (modFolder, sourceRoot) = CopyOfTrackedTemplate();
        try
        {
            var (document, owner, children) = ListWith(sourceRoot, list, atLeast: 3);
            Assert.Equal(children, await ReadBack(sourceRoot, list, owner));

            Rewrite(document, list, owner, children.AsEnumerable().Reverse().ToList());

            Assert.Equal(children.AsEnumerable().Reverse(), await ReadBack(sourceRoot, list, owner));
        }
        finally
        {
            CompileRoundTripGateFixture.TryDelete(modFolder);
        }
    }

    private (string ModFolder, string SourceRoot) CopyOfTrackedTemplate()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-hand-edited-list-").FullName;
        CompileRoundTripGateFixture.CopyDirectory(fixture.TrackedTemplateFolder, modFolder);
        return (modFolder, Path.Combine(modFolder, SourceRepository.RootFor(CutDownPluginFixture.PluginFileName)));
    }

    // The array named by the row inside a document: a quest's own DialogTopics, or the Responses of
    // one of its topics, keyed by the owner of the array.
    private static JsonArray? ArrayOf(JsonObject root, string list, string? owner) => list switch
    {
        QuestTopics => root[nameof(Quest.DialogTopics)] as JsonArray,
        TopicResponses => (root[nameof(Quest.DialogTopics)] as JsonArray)?
            .Select(t => t!.AsObject())
            .FirstOrDefault(t => owner == null
                ? t[nameof(DialogTopic.Responses)] is JsonArray
                : FormKeyOf(t) == owner)?[nameof(DialogTopic.Responses)] as JsonArray,
        _ => throw new ArgumentOutOfRangeException(nameof(list), list, "No such embedded list."),
    };

    private static string FormKeyOf(JsonNode node) => node[nameof(IMajorRecordGetter.FormKey)]!.GetValue<string>();

    // The first document holding a long enough array, the FormKey of the record owning the array,
    // and the children's FormKeys in the array's order. A real quest that has only a short list is
    // skipped, never padded.
    private static (string Document, string Owner, IReadOnlyList<string> Children) ListWith(string sourceRoot, string list, int atLeast)
    {
        foreach (var document in Directory.EnumerateFiles(sourceRoot, "*.json", SearchOption.AllDirectories))
        {
            if (JsonNode.Parse(File.ReadAllText(document)) is not JsonObject root || root[nameof(Quest.DialogTopics)] is not JsonArray topics) continue;
            var candidates = list == QuestTopics
                ? [root]
                : topics.Select(t => t!.AsObject()).ToList();
            foreach (var candidate in candidates)
            {
                var owner = FormKeyOf(candidate);
                if (ArrayOf(root, list, owner) is { } array && array.Count >= atLeast)
                    return (document, owner, [.. array.Select(FormKeyOf!)]);
            }
        }
        throw new InvalidOperationException($"The real fixture holds no {list} with {atLeast} or more elements.");
    }

    private static async Task<IReadOnlyList<string>> ReadBack(string sourceRoot, string list, string owner)
    {
        var mod = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            sourceRoot, InlineWorkDropoff.Instance, CancellationToken.None);
        var quests = ((IFallout4ModGetter)mod).Quests;
        return list == QuestTopics
            ? [.. quests.Single(q => q.FormKey.ToString() == owner).DialogTopics.Select(t => t.FormKey.ToString())]
            : [.. quests.SelectMany(q => q.DialogTopics).Single(t => t.FormKey.ToString() == owner).Responses.Select(r => r.FormKey.ToString())];
    }

    // Reorders and drops elements of the array by identity; every element's own text is untouched.
    private static void Rewrite(string document, string list, string owner, IReadOnlyList<string> order)
    {
        var root = JsonNode.Parse(File.ReadAllText(document))!.AsObject();
        var array = ArrayOf(root, list, owner)!;
        var byFormKey = array.ToDictionary(e => FormKeyOf(e!), e => e!.DeepClone());
        var holder = array.Parent!.AsObject();
        var member = list == QuestTopics ? nameof(Quest.DialogTopics) : nameof(DialogTopic.Responses);
        holder[member] = new JsonArray([.. order.Select(formKey => byFormKey[formKey])]);
        File.WriteAllText(document, root.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }
}
