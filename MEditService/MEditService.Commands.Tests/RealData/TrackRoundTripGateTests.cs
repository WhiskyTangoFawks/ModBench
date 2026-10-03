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
        foreach (var slot in new[] { nameof(Quest.DialogTopics), nameof(Quest.DialogBranches), nameof(Quest.Scenes), nameof(DialogTopic.Responses) })
        {
            Assert.DoesNotContain(
                Directory.EnumerateDirectories(fixture.SourceRoot, "*", SearchOption.AllDirectories),
                d => Path.GetFileName(d) == slot);
        }

        foreach (var quest in quests)
        {
            var parsed = JsonNode.Parse(File.ReadAllText(TheSingleDocumentCarrying(documents, quest.FormKey.ToString())))
                ?? throw new InvalidOperationException($"Expected {quest.FormKey}'s document to parse as JSON.");
            var root = parsed.AsObject();

            foreach (var (slot, children) in new (string, IEnumerable<IMajorRecordGetter>)[]
                     {
                         (nameof(Quest.DialogTopics), quest.DialogTopics),
                         (nameof(Quest.DialogBranches), quest.DialogBranches),
                         (nameof(Quest.Scenes), quest.Scenes),
                     })
            {
                var expected = children.Select(c => c.FormKey.ToString()).ToList();
                foreach (var child in expected)
                    Assert.Null(SourceRepository.PathCarrying(documents, CutDownPluginFixture.PluginFileName, child));
                if (expected.Count == 0)
                {
                    Assert.Null(root[slot]);
                    continue;
                }
                Assert.Equal(
                    expected,
                    RequireNode(root[slot], slot).AsArray().Select(FormKeyOf));
            }

            foreach (var topic in quest.DialogTopics)
            {
                foreach (var response in topic.Responses)
                {
                    Assert.Null(SourceRepository.PathCarrying(
                        documents, CutDownPluginFixture.PluginFileName, response.FormKey.ToString()));
                }
                var inline = RequireNode(root[nameof(Quest.DialogTopics)], nameof(Quest.DialogTopics)).AsArray()
                    .Single(t => FormKeyOf(t) == topic.FormKey.ToString())
                    ?? throw new InvalidOperationException($"Expected {topic.FormKey} to be present among inlined dialog topics.");
                Assert.Equal(
                    topic.Responses.Select(r => r.FormKey.ToString()),
                    inline[nameof(DialogTopic.Responses)]?.AsArray().Select(FormKeyOf) ?? []);
            }
        }
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
        foreach (var (path, bytes) in libraryGroupDocuments)
            Assert.True(bytes.AsSpan().SequenceEqual(trackedGroupDocuments[path]), $"{path} is not the library's own document.");
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
