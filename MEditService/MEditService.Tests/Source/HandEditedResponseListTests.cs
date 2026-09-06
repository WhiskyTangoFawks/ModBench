using System.Text.Json.Nodes;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.RealData;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Tests.Source;

/// <summary>A topic's responses are the <c>Responses</c> array of its own document, so a hand edit
/// of that array is an ordinary edit: an element removed is a deletion, and the array's order is
/// the order the game will see.</summary>
public sealed class HandEditedResponseListTests(CompileRoundTripGateFixture fixture)
    : IClassFixture<CompileRoundTripGateFixture>
{
    [Fact]
    public async Task AResponseElementRemovedByHand_ReadsAsADeletion()
    {
        var (modFolder, sourceRoot) = CopyOfTrackedTemplate();
        try
        {
            var (topicDocument, responses) = TopicWithResponses(sourceRoot, atLeast: 2);
            var removed = responses[^1];
            RewriteResponses(topicDocument, responses.Take(responses.Count - 1).ToList());

            var readBack = await ReadResponses(sourceRoot, topicDocument);

            Assert.Equal(responses.Take(responses.Count - 1), readBack);
            Assert.DoesNotContain(removed, readBack);
        }
        finally
        {
            CompileRoundTripGateFixture.TryDelete(modFolder);
        }
    }

    // Reversed rather than shuffled: a reversal of three or more cannot coincide with the original.
    [Fact]
    public async Task ReversingATopicsResponsesArray_ReversesTheResponsesItReadsBack()
    {
        var (modFolder, sourceRoot) = CopyOfTrackedTemplate();
        try
        {
            var (topicDocument, responses) = TopicWithResponses(sourceRoot, atLeast: 3);
            Assert.Equal(responses, await ReadResponses(sourceRoot, topicDocument));

            RewriteResponses(topicDocument, responses.AsEnumerable().Reverse().ToList());

            Assert.Equal(responses.AsEnumerable().Reverse(), await ReadResponses(sourceRoot, topicDocument));
        }
        finally
        {
            CompileRoundTripGateFixture.TryDelete(modFolder);
        }
    }

    private (string ModFolder, string SourceRoot) CopyOfTrackedTemplate()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-hand-edited-responses-").FullName;
        CompileRoundTripGateFixture.CopyDirectory(fixture.TrackedTemplateFolder, modFolder);
        return (modFolder, Path.Combine(modFolder, SourceRecordPath.RootFor(CutDownPluginFixture.PluginFileName)));
    }

    // A topic document and its responses' FormKeys, in the array's order.
    private static (string Document, IReadOnlyList<string> Responses) TopicWithResponses(string sourceRoot, int atLeast) =>
        Directory.EnumerateFiles(sourceRoot, "*.json", SearchOption.AllDirectories)
            .Select(f => (Document: f, Responses: ResponsesIn(f)))
            .First(t => t.Responses.Count >= atLeast);

    // Elements with a FormKey: a response record's own Responses member holds keyless structs.
    private static IReadOnlyList<string> ResponsesIn(string document) =>
        JsonNode.Parse(File.ReadAllText(document)) is JsonObject root
        && root[nameof(DialogTopic.Responses)] is JsonArray responses
            ? [.. responses.Select(r => r?[nameof(IMajorRecordGetter.FormKey)]?.GetValue<string>()).OfType<string>()]
            : [];

    private static async Task<IReadOnlyList<string>> ReadResponses(string sourceRoot, string topicDocument)
    {
        var topicFormKey = JsonNode.Parse(File.ReadAllText(topicDocument))![nameof(IMajorRecordGetter.FormKey)]!.GetValue<string>();
        var mod = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            sourceRoot, InlineWorkDropoff.Instance, CancellationToken.None);
        var topic = ((IFallout4ModGetter)mod).Quests
            .SelectMany(quest => quest.DialogTopics)
            .Single(candidate => candidate.FormKey.ToString() == topicFormKey);
        return [.. topic.Responses.Select(response => response.FormKey.ToString())];
    }

    // Reorders and drops elements of the array by identity; every element's own text is untouched.
    private static void RewriteResponses(string topicDocument, IReadOnlyList<string> order)
    {
        var root = JsonNode.Parse(File.ReadAllText(topicDocument))!.AsObject();
        var byFormKey = root[nameof(DialogTopic.Responses)]!.AsArray()
            .ToDictionary(r => r![nameof(IMajorRecordGetter.FormKey)]!.GetValue<string>(), r => r!.DeepClone());
        root[nameof(DialogTopic.Responses)] = new JsonArray([.. order.Select(formKey => byFormKey[formKey])]);
        File.WriteAllText(topicDocument, root.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }
}
