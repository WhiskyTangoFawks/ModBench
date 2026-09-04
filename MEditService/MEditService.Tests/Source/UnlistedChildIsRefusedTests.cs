using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.RealData;
using Mutagen.Bethesda.Fallout4;
using Noggog.WorkEngine;

namespace MEditService.Tests.Source;

/// <summary>Deliberately asymmetric (ADR-0042 decision 4): a listed child with no file is a
/// hand deletion, while a file nothing can place is refused, appending inventing a
/// position.</summary>
public sealed class UnlistedChildIsRefusedTests(CompileRoundTripGateFixture fixture)
    : IClassFixture<CompileRoundTripGateFixture>
{
    [Fact]
    public async Task AResponseFileItsTopicDoesNotName_RefusesTheRead_NamingTheParentAndTheChild()
    {
        var (modFolder, sourceRoot) = CopyOfTrackedTemplate();
        try
        {
            var topicDirectory = TopicWithResponses(sourceRoot);
            var carrier = SourceChildOrder.CarrierFor(topicDirectory, parentIsRecord: true);
            var listed = SourceChildOrder.ListAt(carrier, nameof(DialogTopic.Responses));

            // Drop one entry from the list while leaving its file exactly where it is — an external
            // tool's half-finished edit, or a merge that resolved the parent but not the tree.
            var orphaned = listed[^1];
            RewriteOrder(carrier, nameof(DialogTopic.Responses), listed.Take(listed.Count - 1).ToList());

            var refusal = await Assert.ThrowsAsync<SourceChildOrderDriftException>(() =>
                RecordTextCodecGeneratorSeed.DeserializeWholeMod(
                    sourceRoot, InlineWorkDropoff.Instance, CancellationToken.None));

            // Actionable, not just loud: the member, the document that should have named it, the
            // child itself, and the recovery.
            Assert.Contains(nameof(DialogTopic.Responses), refusal.Message, StringComparison.Ordinal);
            Assert.Contains(carrier, refusal.Message, StringComparison.Ordinal);
            Assert.Contains(orphaned, refusal.Message, StringComparison.Ordinal);
            Assert.Contains("re-Track", refusal.Message, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            CompileRoundTripGateFixture.TryDelete(modFolder);
        }
    }

    [Fact]
    public async Task AResponseFileRemovedByHand_IsHonouredAsADeletion_NotRefused()
    {
        var (modFolder, sourceRoot) = CopyOfTrackedTemplate();
        try
        {
            var topicDirectory = TopicWithResponses(sourceRoot);
            var carrier = SourceChildOrder.CarrierFor(topicDirectory, parentIsRecord: true);
            var listedBefore = SourceChildOrder.ListAt(carrier, nameof(DialogTopic.Responses));

            var responses = Path.Combine(topicDirectory, nameof(DialogTopic.Responses));
            var victim = Directory.GetFiles(responses).Order(StringComparer.Ordinal).Last();
            File.Delete(victim);

            var mod = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
                sourceRoot, InlineWorkDropoff.Instance, CancellationToken.None);

            var topic = ((IFallout4ModGetter)mod).Quests
                .SelectMany(quest => quest.DialogTopics)
                .Single(candidate => Path.GetFileName(topicDirectory).EndsWith(
                    $"{candidate.FormKey.ID:X6}_{candidate.FormKey.ModKey.FileName}", StringComparison.Ordinal));

            Assert.Equal(listedBefore.Count - 1, topic.Responses.Count);
        }
        finally
        {
            CompileRoundTripGateFixture.TryDelete(modFolder);
        }
    }

    private (string ModFolder, string SourceRoot) CopyOfTrackedTemplate()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-unlisted-child-").FullName;
        CompileRoundTripGateFixture.CopyDirectory(fixture.TrackedTemplateFolder, modFolder);
        return (modFolder, Path.Combine(modFolder, SourceRecordPath.RootFor(CutDownPluginFixture.PluginFileName)));
    }

    private static string TopicWithResponses(string sourceRoot) => Directory
        .EnumerateDirectories(sourceRoot, nameof(DialogTopic.Responses), SearchOption.AllDirectories)
        .Select(Path.GetDirectoryName)
        .Select(directory => directory!)
        .First(directory => SourceChildOrder
            .ListAt(SourceChildOrder.CarrierFor(directory, parentIsRecord: true), nameof(DialogTopic.Responses))
            .Count >= 2);

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
