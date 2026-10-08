using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.RealData;

public sealed class TrackRoundTripGateTests(TrackedCutDownFixture fixture)
    : IClassFixture<TrackedCutDownFixture>
{
    private static JsonNode RequireNode(JsonNode? node, string what) =>
        node ?? throw new InvalidOperationException($"Expected {what} to be present.");

    private static string FormKeyOf(JsonNode? recordNode) =>
        RequireNode(recordNode, "a record node")[nameof(IMajorRecordGetter.FormKey)] is { } formKeyNode
            ? formKeyNode.GetValue<string>()
            : throw new InvalidOperationException("Expected a FormKey member.");

    [Fact]
    public void Track_OfTheRealFixture_WritesEveryQuestDescendantInlineInItsQuestsDocument_InTheBinarysOrder()
    {
        using var original = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var quests = ((IFallout4ModGetter)original).Quests
            .Where(q => q.DialogTopics.Count + q.DialogBranches.Count + q.Scenes.Count > 0)
            .ToList();
        Assert.Contains(quests, q => q.DialogTopics.Count >= 2);
        Assert.Contains(quests, q => q.Scenes.Count >= 1);

        var documents = fixture.Documents();

        var questDocuments = quests
            .Select(quest => (Quest: quest, Root: RequireNode(
                JsonNode.Parse(documents.Single(document => document.FormKey == quest.FormKey.ToString()).Body),
                $"{quest.FormKey}'s document").AsObject()))
            .ToList();

        var slotCases = questDocuments
            .SelectMany(document => new (string Slot, IEnumerable<IMajorRecordGetter> Children)[]
            {
                (nameof(Quest.DialogTopics), document.Quest.DialogTopics),
                (nameof(Quest.DialogBranches), document.Quest.DialogBranches),
                (nameof(Quest.Scenes), document.Quest.Scenes),
            }.Select(slot => (document.Root, slot.Slot, Expected: slot.Children.Select(c => c.FormKey.ToString()).ToList())))
            .ToList();
        Assert.All(
            slotCases.SelectMany(slotCase => slotCase.Expected),
            child => Assert.DoesNotContain(documents, document => document.FormKey == child));
        Assert.All(slotCases, slotCase => Assert.Equal(slotCase.Expected.Count == 0, slotCase.Root[slotCase.Slot] is null));
        Assert.All(
            slotCases.Where(slotCase => slotCase.Expected.Count > 0),
            slotCase => Assert.Equal(
                slotCase.Expected,
                RequireNode(slotCase.Root[slotCase.Slot], slotCase.Slot).AsArray().Select(FormKeyOf)));

        var topicCases = questDocuments
            .SelectMany(document => document.Quest.DialogTopics.Select(topic => (document.Root, Topic: topic)))
            .ToList();
        Assert.All(
            topicCases.SelectMany(topicCase => topicCase.Topic.Responses),
            response => Assert.DoesNotContain(documents, document => document.FormKey == response.FormKey.ToString()));
        Assert.All(topicCases, topicCase =>
        {
            var inline = RequireNode(topicCase.Root[nameof(Quest.DialogTopics)], nameof(Quest.DialogTopics)).AsArray()
                .Single(t => FormKeyOf(t) == topicCase.Topic.FormKey.ToString());
            Assert.Equal(
                topicCase.Topic.Responses.Select(r => r.FormKey.ToString()),
                inline?[nameof(DialogTopic.Responses)]?.AsArray().Select(FormKeyOf) ?? []);
        });
    }

    [Fact]
    public void Track_OfTheRealFixture_WritesTheNonZeroTimestampsOfCell03C0F0()
    {
        var cellText = fixture.Documents().Single(document => document.FormKey.Contains("03C0F0", StringComparison.Ordinal)).Body;

        Assert.Contains("\"PersistentTimestamp\": 138972", cellText, StringComparison.Ordinal);
        Assert.Contains("\"TemporaryTimestamp\": 138972", cellText, StringComparison.Ordinal);
    }

    [Fact]
    public void Track_OfTheRealFixture_WritesTheNonDefaultConditionUnknown1PadOfAFallout4EsmResponse()
    {
        var topicDocumentText = fixture.Documents()
            .Single(document => document.Body.Contains("\"FormKey\": \"01AACD:Fallout4.esm\"", StringComparison.Ordinal)).Body;
        Assert.Contains("\"Unknown1\": \"0x1D9D68\"", topicDocumentText, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("\"MasterReferences\"")]
    [InlineData("\"NumRecords\"")]
    public void Track_OfTheRealFixture_WritesNoValueThePluginDerives(string member)
    {
        Assert.DoesNotContain(fixture.Documents(), document => document.Body.Contains(member, StringComparison.Ordinal));
    }
}
