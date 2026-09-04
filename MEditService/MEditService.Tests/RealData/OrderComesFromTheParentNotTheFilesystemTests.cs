using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>Reverses the recorded order rather than shuffling files: enumeration order is the
/// filesystem's to choose and often agrees with the recorded order by luck.</summary>
public sealed class OrderComesFromTheParentNotTheFilesystemTests(CompileRoundTripGateFixture fixture)
    : IClassFixture<CompileRoundTripGateFixture>
{
    [Fact]
    public async Task ReversingATopicsRecordedOrder_ReversesTheResponsesItReadsBack()
    {
        // Its own copy of the already-tracked template: this test rewrites a document in place, and
        // the shared fixture tree is read-only to everyone else.
        var modFolder = Directory.CreateTempSubdirectory("medit-order-carrier-").FullName;
        CompileRoundTripGateFixture.CopyDirectory(fixture.TrackedTemplateFolder, modFolder);
        var sourceRoot = Path.Combine(modFolder, SourceRecordPath.RootFor(CutDownPluginFixture.PluginFileName));

        // A topic with enough responses that a reversal cannot coincide with the original.
        var topicDirectory = Directory
            .EnumerateDirectories(sourceRoot, "Responses", SearchOption.AllDirectories)
            .Select(Path.GetDirectoryName)
            .Select(directory => directory!)
            .First(directory => SourceChildOrder
                .ListAt(SourceChildOrder.CarrierFor(directory, parentIsRecord: true), "Responses").Count >= 3);

        var carrier = SourceChildOrder.CarrierFor(topicDirectory, parentIsRecord: true);
        var recorded = SourceChildOrder.ListAt(carrier, "Responses");

        var before = await ReadResponses(sourceRoot, topicDirectory);
        Assert.Equal(recorded, before);

        // Reverse the list in the parent's document. Not one file is touched, renamed or moved.
        var namesBefore = Directory.GetFiles(Path.Combine(topicDirectory, "Responses")).Order(StringComparer.Ordinal).ToList();
        RewriteOrder(carrier, "Responses", recorded.Reverse().ToList());

        var after = await ReadResponses(sourceRoot, topicDirectory);

        Assert.Equal(recorded.Reverse().ToList(), after);
        Assert.NotEqual(before, after);
        Assert.Equal(
            namesBefore,
            Directory.GetFiles(Path.Combine(topicDirectory, "Responses")).Order(StringComparer.Ordinal).ToList());

        CompileRoundTripGateFixture.TryDelete(modFolder);
    }

    private static async Task<List<string>> ReadResponses(string sourceRoot, string topicDirectory)
    {
        var mod = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            sourceRoot, InlineWorkDropoff.Instance, CancellationToken.None);

        var topicLeaf = Path.GetFileName(topicDirectory);
        var topic = ((IFallout4ModGetter)mod).Quests
            .SelectMany(quest => quest.DialogTopics)
            .Single(candidate => topicLeaf.EndsWith(
                $"{candidate.FormKey.ID:X6}_{candidate.FormKey.ModKey.FileName}", StringComparison.Ordinal));

        return [.. topic.Responses.Select(response => response.FormKey.ToString())];
    }

    private static void RewriteOrder(string carrierPath, string key, IReadOnlyList<string> order)
    {
        var document = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(carrierPath))!.AsObject();
        var list = new System.Text.Json.Nodes.JsonArray();
        foreach (var identity in order) list.Add(identity);
        document[SourceChildOrder.OrderMember]!.AsObject()[key] = list;

        File.WriteAllText(
            carrierPath, document.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }
}
