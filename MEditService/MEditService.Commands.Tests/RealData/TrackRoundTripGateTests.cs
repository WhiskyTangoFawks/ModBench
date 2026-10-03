using System.Text.Json.Nodes;
using MEditService.SourceAdapter;
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

    private const string CellRecordPathByPatternNotByBlockNumber =
        @"^Cells/(\[\d+\] )?-?\d+/(\[\d+\] )?-?\d+/[^/]+/RecordData\.json$";

    private const string WorldspaceRecordPathByPatternNotByBlockNumber =
        @"^Worldspaces/[^/]+/(\[\d+\] )?-?\d+, -?\d+/(\[\d+\] )?-?\d+, -?\d+/[^/]+/RecordData\.json$";

    private static string FormKeyOf(JsonNode? recordNode) =>
        RequireNode(recordNode, "a record node")[nameof(IMajorRecordGetter.FormKey)] is { } formKeyNode
            ? formKeyNode.GetValue<string>()
            : throw new InvalidOperationException("Expected a FormKey member.");

    [Fact]
    public void Track_OfTheRealFixture_WritesTheSourceContainerLayout()
    {
        var allFiles = Directory.EnumerateFiles(fixture.SourceRoot, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(fixture.SourceRoot, f).Replace('\\', '/'))
            .ToList();
        Assert.NotEmpty(allFiles);

        Assert.Contains(allFiles, f => System.Text.RegularExpressions.Regex.IsMatch(f, CellRecordPathByPatternNotByBlockNumber));
        Assert.Contains(allFiles, f => System.Text.RegularExpressions.Regex.IsMatch(f, WorldspaceRecordPathByPatternNotByBlockNumber));
    }

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

        var documents = Directory.EnumerateFiles(fixture.SourceRoot, "*.json", SearchOption.AllDirectories).ToList();
        string[] questDescendantSlots =
            [nameof(Quest.DialogTopics), nameof(Quest.DialogBranches), nameof(Quest.Scenes), nameof(DialogTopic.Responses)];
        Assert.DoesNotContain(
            Directory.EnumerateDirectories(fixture.SourceRoot, "*", SearchOption.AllDirectories),
            d => questDescendantSlots.Contains(Path.GetFileName(d)));

        var questDocuments = quests
            .Select(quest => (Quest: quest, Root: RequireNode(
                JsonNode.Parse(File.ReadAllText(TheSingleDocumentCarrying(documents, quest.FormKey.ToString()))),
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
            child => Assert.Null(SourceRepository.PathCarrying(documents, CutDownPluginFixture.PluginFileName, child)));
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
            response => Assert.Null(SourceRepository.PathCarrying(
                documents, CutDownPluginFixture.PluginFileName, response.FormKey.ToString())));
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
    public void Track_OfTheRealFixture_WritesOnlyTheGroupDocumentsTheLibraryWrites()
    {
        var libraryTree = CutDownPluginFixture.DeriveSourceTreeFromBinary(CutDownPluginFixture.PluginPath);
        var libraryGroupDocuments = libraryTree
            .Where(kv => Path.GetFileName(kv.Key) == "GroupRecordData.json")
            .ToDictionary(kv => kv.Key, kv => kv.Value);
        Assert.NotEmpty(libraryGroupDocuments);

        var trackedGroupDocuments = fixture.ReadSourceTree()
            .Where(kv => Path.GetFileName(kv.Key) == "GroupRecordData.json")
            .ToDictionary(kv => kv.Key, kv => kv.Value);

        Assert.Equal(libraryGroupDocuments.Keys.Order(), trackedGroupDocuments.Keys.Order());
        Assert.All(
            libraryGroupDocuments,
            document => Assert.True(
                document.Value.AsSpan().SequenceEqual(trackedGroupDocuments[document.Key]),
                $"{document.Key} is not the library's own document."));
    }

    internal static string TheSingleDocumentCarrying(IReadOnlyList<string> documents, string formKey) =>
        documents.Single(
            f => SourceRepository.PathCarrying([f], CutDownPluginFixture.PluginFileName, formKey) != null);

    [Fact]
    public void Track_OfTheRealFixture_WritesTheNonZeroTimestampsOfCell03C0F0()
    {
        var cellFile = Directory.EnumerateFiles(fixture.SourceRoot, "RecordData.json", SearchOption.AllDirectories)
            .Single(f => f.Contains("03C0F0", StringComparison.Ordinal));
        var cellText = File.ReadAllText(cellFile);

        Assert.Contains("\"PersistentTimestamp\": 138972", cellText, StringComparison.Ordinal);
        Assert.Contains("\"TemporaryTimestamp\": 138972", cellText, StringComparison.Ordinal);
    }

    [Fact]
    public void Track_OfTheRealFixture_WritesTheNonDefaultConditionUnknown1PadOfAFallout4EsmResponseAndHeaderStats()
    {
        var topicDocumentText = File.ReadAllText(Directory.EnumerateFiles(fixture.SourceRoot, "*.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains("\"FormKey\": \"01AACD:Fallout4.esm\"", StringComparison.Ordinal)));
        Assert.Contains("\"Unknown1\": \"0x1D9D68\"", topicDocumentText, StringComparison.Ordinal);

        var rootText = File.ReadAllText(Path.Combine(fixture.SourceRoot, "RecordData.json"));
        Assert.Contains("\"NumRecords\": 4743", rootText, StringComparison.Ordinal);
        Assert.Contains("\"NextFormID\": 2049", rootText, StringComparison.Ordinal);
    }
}
