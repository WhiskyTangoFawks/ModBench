using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>Both ingest paths land the same rows over the same mod shape, so there is no second
/// extraction to drift; this checks it on 3,940 authentic records.</summary>
public sealed class SourceIngestParityTests(SourceParityFixture fixture) : IClassFixture<SourceParityFixture>
{
    [Fact]
    public void TheTrackedPluginReallyIngestedFromSource_NotViaTheBinaryFallback()
    {
        Assert.Empty(fixture.FromSource.Status.Failures);
        Assert.True(SourceRepository.HoldsTreeFor(fixture.ModFolder, CutDownPluginFixture.PluginFileName));
    }

    [Fact]
    public void TheSameRecordsExist_TrackedAndUntracked()
    {
        var binary = AllFormKeys(fixture.FromBinary).ToHashSet(StringComparer.Ordinal);
        var source = AllFormKeys(fixture.FromSource).ToHashSet(StringComparer.Ordinal);

        // The fixture is real data with real containers; an empty or tiny set here would make every
        // other assertion in this file vacuous.
        Assert.True(binary.Count > 2000, $"fixture looks wrong: only {binary.Count} records");
        Assert.Equal(binary.Count, source.Count);
        Assert.Empty(binary.Except(source, StringComparer.Ordinal));
        Assert.Empty(source.Except(binary, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryEmbeddedChildRecord_IsItsOwnQueryableRecord_OnBothPaths()
    {
        var embeddedTypes = new[] { "refr", "achr", "navm", "land", "cell", "pgre", "pmis", "phzd" };

        foreach (var type in embeddedTypes)
        {
            var binary = CountOf(fixture.FromBinary, type);
            if (binary == 0) continue;

            Assert.Equal(binary, CountOf(fixture.FromSource, type));
        }

        // Positive control: the fixture must really hold embedded children, or the loop above is a
        // walk over an empty set that would pass for a plugin with no containers at all.
        Assert.True(CountOf(fixture.FromBinary, "refr") > 0, "fixture holds no placed references");
        Assert.True(CountOf(fixture.FromBinary, "cell") > 0, "fixture holds no cells");
    }

    // One unpaged query: Search orders by editor_id, which is non-unique and null for every placed
    // ref, so LIMIT/OFFSET pages silently skip and repeat rows.
    private List<string> AllFormKeys(IndexProjector index) =>
        [.. index.RequireReads()
            .Search(new RecordQuery(Plugin: fixture.Plugin.Name, Origin: fixture.Plugin.Origin, Limit: int.MaxValue))
            .Items.Select(i => i.FormKey)];

    private int CountOf(IndexProjector index, string recordType) =>
        index.RequireReads().GetRecordTypeCounts(fixture.Plugin).FirstOrDefault(c => c.Type == recordType)?.Count ?? 0;

    private Dictionary<string, RecordDocument> DocumentsByFormKey(IndexProjector index) =>
        index.RequireReads().GetDocuments(fixture.Plugin).ToDictionary(d => d.FormKey, StringComparer.Ordinal);

    [Fact]
    public void EveryRecordsDocument_IsByteIdentical_ExceptOnePinnedOverlayVsDeepParseCellDivergence()
    {
        var binaryDocuments = DocumentsByFormKey(fixture.FromBinary);
        var sourceDocuments = DocumentsByFormKey(fixture.FromSource);

        var mismatched = new List<string>();
        var byType = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (formKey, binary) in binaryDocuments)
        {
            var source = sourceDocuments.GetValueOrDefault(formKey);
            if (binary.Body == source?.Body) continue;
            mismatched.Add(formKey);
            byType[binary.RecordType] = byType.GetValueOrDefault(binary.RecordType) + 1;
        }

        var byTypeText = string.Join(", ", byType.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}={kv.Value}"));

        // Pinned count and type. The fixture is hermetic and checked in, so any drift here is signal.
        Assert.True(mismatched.Count == 1, $"expected exactly the one known divergence; got {mismatched.Count} ({byTypeText})");
        Assert.Equal("cell=1", byTypeText);

        // ...and pinned to the *field*, so another Cell field starting to diverge cannot hide behind
        // the same count.
        var binaryBody = binaryDocuments[mismatched[0]].Body
            ?? throw new InvalidOperationException("Expected the binary-path document to carry a body.");
        var sourceBody = sourceDocuments[mismatched[0]].Body
            ?? throw new InvalidOperationException("Expected the source-path document to carry a body.");
        Assert.Contains("\"Break2\"", binaryBody, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Break2\"", sourceBody, StringComparison.Ordinal);
        Assert.Equal(
            StripVersioningBlock(binaryBody),
            StripVersioningBlock(sourceBody));
    }

    [Fact]
    public void TheHeaderRow_IsByteIdentical_TrackedAndUntracked()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(CutDownPluginFixture.PluginFileName));

        var binary = fixture.FromBinary.RequireReads().GetDocument(headerFormKey, fixture.Plugin);
        var source = fixture.FromSource.RequireReads().GetDocument(headerFormKey, fixture.Plugin);

        Assert.NotNull(binary);
        Assert.NotNull(source);
        Assert.Equal(PluginHeader.RecordType, binary.RecordType);
        Assert.Equal(PluginHeader.RecordType, source.RecordType);

        // Positive controls: an empty or absent body would satisfy plain equality below and prove
        // nothing at all. These pin that the body really is the root document.
        Assert.NotNull(binary.Body);
        Assert.Contains("\"ModHeader\"", binary.Body, StringComparison.Ordinal);
        Assert.Contains("\"MasterReferences\"", binary.Body, StringComparison.Ordinal);

        Assert.Equal(binary.Body, source.Body);
        Assert.Equal(ContentHashOf(fixture.BinaryInstanceRoot, headerFormKey), ContentHashOf(fixture.SourceInstanceRoot, headerFormKey));

        // The third arm: against the tracked plugin's own file on disk, as raw bytes. `records.body`
        // is VARCHAR, so this is the only comparison here that is genuinely about bytes.
        var headerFile = Path.Combine(fixture.ModFolder, "source", CutDownPluginFixture.PluginFileName, "RecordData.json");
        Assert.True(File.Exists(headerFile), $"expected the tracked tree to hold {headerFile}");
        var sourceBody = source.Body
            ?? throw new InvalidOperationException("Expected the source header document to carry a body.");
        Assert.Equal(File.ReadAllBytes(headerFile), Encoding.UTF8.GetBytes(sourceBody));
    }

    private static string ContentHashOf(string instanceRoot, string formKey) =>
        Assert.IsType<string>(StoreFile.Scalar(instanceRoot, "SELECT content_hash FROM records WHERE form_key = $1", formKey));

    private static string StripVersioningBlock(string body) =>
        System.Text.RegularExpressions.Regex.Replace(
            body, "\"Versioning\": \\[[^\\]]*\\]", "\"Versioning\": []");

    [Fact]
    public void PlacementAndCellLocationRows_AreIdentical_TrackedAndUntracked()
    {
        var placed = AssertTableIdentical("placement");
        var located = AssertTableIdentical("cell_location");

        // Positive controls: two empty tables are trivially equal on both sides.
        Assert.True(placed > 0, "fixture produced no placement rows");
        Assert.True(located > 0, "fixture produced no cell_location rows");
    }

    [Fact]
    public void FormLookupAndReferenceRows_AreIdentical_TrackedAndUntracked()
    {
        AssertTableIdentical("form_lookup");
        var referenced = AssertTableIdentical("form_references", "source_plugin", "source_origin");

        Assert.True(referenced > 0, "fixture produced no form_references rows");
    }

    [Fact]
    public void ContainerChildRows_AreIdentical_TrackedAndUntracked()
    {
        var children = AssertTableIdentical("container_child");

        Assert.True(children > 0, "fixture produced no container_child rows");
    }

    private int AssertTableIdentical(string table, string pluginColumn = "plugin", string originColumn = "origin")
    {
        var binary = Rows(fixture.BinaryInstanceRoot, table, pluginColumn, originColumn);
        var source = Rows(fixture.SourceInstanceRoot, table, pluginColumn, originColumn);

        var firstDifference = Enumerable.Range(0, Math.Max(binary.Count, source.Count))
            .FirstOrDefault(i => i >= binary.Count || i >= source.Count || binary[i] != source[i], -1);
        Assert.True(firstDifference < 0,
            $"{table} differs: {binary.Count} binary rows vs {source.Count} source rows; first difference at row {firstDifference}: " +
            $"binary=[{binary.ElementAtOrDefault(firstDifference) ?? "(missing)"}] source=[{source.ElementAtOrDefault(firstDifference) ?? "(missing)"}]");
        return binary.Count;
    }

    private List<string> Rows(string instanceRoot, string table, string pluginColumn, string originColumn)
    {
        using var connection = StoreFile.Open(instanceRoot);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT * FROM {table} WHERE {pluginColumn} = $1 AND {originColumn} = $2 ORDER BY ALL";
        cmd.Parameters.Add(new DuckDBParameter { Value = fixture.Plugin.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = fixture.Plugin.Origin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<string>();
        var values = new object[reader.FieldCount];
        while (reader.Read())
        {
            reader.GetValues(values);
            rows.Add(string.Join("|", values.Select(v => v is DBNull ? "<NULL>" : Convert.ToString(v, CultureInfo.InvariantCulture))));
        }
        return rows;
    }
}
