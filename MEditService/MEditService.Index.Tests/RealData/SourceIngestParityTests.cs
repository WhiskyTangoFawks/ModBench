using System.Text;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.RealData;

public sealed class SourceIngestParityTests(SourceParityFixture fixture) : IClassFixture<SourceParityFixture>
{
    [Fact]
    public void TheTrackedPluginReallyIngestedFromSource_NotViaTheBinaryFallback()
    {
        Assert.Empty(fixture.FromSource.Status.Failures);
        Assert.True(SourceRepository.HoldsTreeFor(fixture.ModFolder, RealDataPlugin.PluginFileName));
    }

    [Fact]
    public void AFreshlyIngestedRealPlugin_ValidatesCleanAndAdvancesNoSequence()
    {
        Assert.False(fixture.FromSource.Revalidate());
        Assert.Empty(fixture.FromSource.Status.Failures);
    }

    [Fact]
    public void TheSameRecordsExist_TrackedAndUntracked()
    {
        var binary = AllFormKeysInOneUnpagedQuery(fixture.FromBinary).ToHashSet(StringComparer.Ordinal);
        var source = AllFormKeysInOneUnpagedQuery(fixture.FromSource).ToHashSet(StringComparer.Ordinal);

        Assert.True(binary.Count > 2000, $"fixture looks wrong: only {binary.Count} records");
        Assert.Equal(binary.Count, source.Count);
        Assert.Empty(binary.Except(source, StringComparer.Ordinal));
        Assert.Empty(source.Except(binary, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryEmbeddedChildRecord_IsItsOwnQueryableRecord_OnBothPaths()
    {
        foreach (var type in (string[])["refr", "achr", "navm", "land", "cell", "pgre", "pmis", "phzd"])
        {
            var binary = CountOf(fixture.FromBinary, type);
            if (binary == 0) continue;

            Assert.Equal(binary, CountOf(fixture.FromSource, type));
        }

        Assert.True(CountOf(fixture.FromBinary, "refr") > 0, "fixture holds no placed references");
        Assert.True(CountOf(fixture.FromBinary, "cell") > 0, "fixture holds no cells");
    }

    [Fact]
    public void EveryRecordsDocument_IsByteIdentical_ExceptOnePinnedOverlayVsDeepParseCellDivergence()
    {
        var binaryDocuments = DocumentsByFormKey(fixture.BinaryInstanceRoot);
        var sourceDocuments = DocumentsByFormKey(fixture.SourceInstanceRoot);

        var mismatched = new List<string>();
        var byType = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (formKey, binary) in binaryDocuments)
        {
            if (sourceDocuments.TryGetValue(formKey, out var source) && binary.Body == source.Body) continue;
            mismatched.Add(formKey);
            byType[binary.RecordType] = byType.GetValueOrDefault(binary.RecordType) + 1;
        }

        var byTypeText = string.Join(", ", byType.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}={kv.Value}"));

        Assert.True(mismatched.Count == 1, $"expected exactly the one known divergence; got {mismatched.Count} ({byTypeText})");
        Assert.Equal("cell=1", byTypeText);

        var binaryBody = binaryDocuments[mismatched[0]].Body;
        var sourceBody = sourceDocuments[mismatched[0]].Body;
        Assert.Contains("\"Break2\"", binaryBody, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Break2\"", sourceBody, StringComparison.Ordinal);
        Assert.Equal(StripVersioningBlock(binaryBody), StripVersioningBlock(sourceBody));
    }

    [Fact]
    public void TheHeaderRow_IsByteIdentical_TrackedAndUntracked_AndToTheTreesOwnFile()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(RealDataPlugin.PluginFileName));

        var binary = fixture.FromBinary.RequireReads().GetDocument(headerFormKey, fixture.Plugin);
        var source = fixture.FromSource.RequireReads().GetDocument(headerFormKey, fixture.Plugin);

        Assert.NotNull(binary);
        Assert.NotNull(source);
        Assert.Equal(PluginHeader.RecordType, binary.RecordType);
        Assert.Equal(PluginHeader.RecordType, source.RecordType);

        Assert.NotNull(binary.Body);
        Assert.Contains("\"ModHeader\"", binary.Body, StringComparison.Ordinal);
        Assert.Contains("\"MasterReferences\"", binary.Body, StringComparison.Ordinal);

        Assert.Equal(binary.Body, source.Body);

        var headerFile = Path.Combine(fixture.ModFolder, "plugin-source", RealDataPlugin.PluginFileName, "RecordData.json");
        Assert.True(File.Exists(headerFile), $"expected the tracked tree to hold {headerFile}");
        Assert.Equal(File.ReadAllBytes(headerFile), Encoding.UTF8.GetBytes(source.BodyOf()));
    }

    [Theory]
    [InlineData("placement")]
    [InlineData("cell_location")]
    [InlineData("form_lookup")]
    [InlineData("form_references")]
    [InlineData("container_child")]
    public void ASideTablesRows_AreIdentical_TrackedAndUntracked(string relation)
    {
        var binary = RowsOf(fixture.BinaryInstanceRoot, relation);
        var source = RowsOf(fixture.SourceInstanceRoot, relation);

        Assert.True(binary.Count > 0, $"the fixture produced no {relation} rows");
        var onlyBinary = binary.Except(source, StringComparer.Ordinal).ToList();
        var onlySource = source.Except(binary, StringComparer.Ordinal).ToList();
        Assert.True(
            binary.SequenceEqual(source, StringComparer.Ordinal),
            $"{relation}: {binary.Count} rows untracked, {source.Count} tracked." +
            $"\nOnly untracked:\n{string.Join('\n', onlyBinary.Take(20))}\nOnly tracked:\n{string.Join('\n', onlySource.Take(20))}");
    }

    private List<string> AllFormKeysInOneUnpagedQuery(Indexer index) =>
        [.. index.RequireReads()
            .Search(new RecordQuery(Plugin: fixture.Plugin.Name, Origin: fixture.Plugin.Origin, Limit: int.MaxValue))
            .Items.Select(i => i.FormKey)];

    private int CountOf(Indexer index, string recordType) =>
        index.RequireReads().Search(new RecordQuery(
            RecordTypes: [recordType], Plugin: fixture.Plugin.Name, Origin: fixture.Plugin.Origin, Limit: 0)).Total;

    private static Dictionary<string, (string RecordType, string Body)> DocumentsByFormKey(string instanceRoot) =>
        IndexFiles.Rows(instanceRoot, "SELECT form_key, record_type, body FROM records")
            .ToDictionary(row => row[0], row => (row[1], row[2]), StringComparer.Ordinal);

    private static string StripVersioningBlock(string body) =>
        Regex.Replace(body, "\"Versioning\": \\[[^\\]]*\\]", "\"Versioning\": []");

    private static List<string> RowsOf(string instanceRoot, string relation) =>
        [.. IndexFiles.Rows(instanceRoot, $"SELECT * FROM {relation}").Select(row => string.Join(" | ", row))];
}
