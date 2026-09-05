using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>Both ingest paths call the same <see cref="IRecordIndex.Index"/> over the same mod shape, so
/// there is no second extraction to drift; this checks it on 3,940 authentic records.</summary>
public sealed class SourceIngestParityTests(SourceParityFixture fixture) : IClassFixture<SourceParityFixture>
{
    private LoadOrderMirror FromBinary => fixture.FromBinary;
    private LoadOrderMirror FromSource => fixture.FromSource;
    private PluginKey Plugin => fixture.Plugin;

    [Fact]
    public void TheTrackedPluginReallyIngestedFromSource_NotViaTheBinaryFallback()
    {
        Assert.Empty(FromSource.Status.Failures);
        Assert.NotNull(SourceIngest.TreeFor(SourceParityFixture.Origin, Path.Combine(fixture.ModFolder, CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginFileName));
    }

    [Fact]
    public void TheSameRecordsExist_TrackedAndUntracked()
    {
        var binary = AllFormKeys(FromBinary).ToHashSet(StringComparer.Ordinal);
        var source = AllFormKeys(FromSource).ToHashSet(StringComparer.Ordinal);

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
            var binary = CountOf(FromBinary, type);
            if (binary == 0) continue;

            Assert.Equal(binary, CountOf(FromSource, type));
        }

        // Positive control: the fixture must really hold embedded children, or the loop above is a
        // walk over an empty set that would pass for a plugin with no containers at all.
        Assert.True(CountOf(FromBinary, "refr") > 0, "fixture holds no placed references");
        Assert.True(CountOf(FromBinary, "cell") > 0, "fixture holds no cells");
    }

    // One unpaged query: Search orders by editor_id, which is non-unique and null for every placed
    // ref, so LIMIT/OFFSET pages silently skip and repeat rows.
    private List<string> AllFormKeys(LoadOrderMirror mirror) =>
        [.. mirror.Index!.At(RecordRef.Effective).Search(new RecordQuery(Plugin: Plugin, Limit: int.MaxValue)).Items.Select(i => i.FormKey)];

    private int CountOf(LoadOrderMirror mirror, string recordType) =>
        mirror.Index!.At(RecordRef.Effective).GetRecordTypeCounts(Plugin).FirstOrDefault(c => c.Type == recordType)?.Count ?? 0;

    private Dictionary<string, RecordDocument> DocumentsByFormKey(LoadOrderMirror mirror) =>
        mirror.Index!.At(RecordRef.Effective).GetDocuments(Plugin).ToDictionary(d => d.FormKey, StringComparer.Ordinal);

    [Fact]
    public void EveryRecordsDocument_IsByteIdentical_ExceptOnePinnedOverlayVsDeepParseCellDivergence()
    {
        var binaryDocuments = DocumentsByFormKey(FromBinary);
        var sourceDocuments = DocumentsByFormKey(FromSource);

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
        var binaryBody = binaryDocuments[mismatched[0]].Body!;
        var sourceBody = sourceDocuments[mismatched[0]].Body!;
        Assert.Contains("\"Break2\"", binaryBody, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Break2\"", sourceBody, StringComparison.Ordinal);
        Assert.Equal(
            StripVersioningBlock(binaryBody),
            StripVersioningBlock(sourceBody));
    }

    [Fact]
    public void TheHeaderRow_IsByteIdentical_TrackedAndUntracked()
    {
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(CutDownPluginFixture.PluginFileName));

        var binary = FromBinary.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, Plugin);
        var source = FromSource.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, Plugin);

        Assert.NotNull(binary);
        Assert.NotNull(source);
        Assert.Equal(HeaderIndexer.RecordType, binary.RecordType);
        Assert.Equal(HeaderIndexer.RecordType, source.RecordType);

        // Positive controls: an empty or absent body would satisfy plain equality below and prove
        // nothing at all. These pin that the body really is the root document.
        Assert.NotNull(binary.Body);
        Assert.Contains("\"ModHeader\"", binary.Body, StringComparison.Ordinal);
        Assert.Contains("\"MasterReferences\"", binary.Body, StringComparison.Ordinal);

        Assert.Equal(binary.Body, source.Body);
        Assert.Equal(ContentHashOf(FromBinary, headerFormKey), ContentHashOf(FromSource, headerFormKey));

        // The third arm: against the tracked plugin's own file on disk, as raw bytes. `records.body`
        // is VARCHAR, so this is the only comparison here that is genuinely about bytes.
        var headerFile = Path.Combine(fixture.ModFolder, "source", CutDownPluginFixture.PluginFileName, "RecordData.json");
        Assert.True(File.Exists(headerFile), $"expected the tracked tree to hold {headerFile}");
        Assert.Equal(File.ReadAllBytes(headerFile), Encoding.UTF8.GetBytes(source.Body!));
    }

    private static string ContentHashOf(LoadOrderMirror mirror, string formKey)
    {
        using var cmd = ((DuckDbRecordIndex)mirror.Index!).Connection.CreateCommand();
        cmd.CommandText = "SELECT content_hash FROM records WHERE form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        return Assert.IsType<string>(cmd.ExecuteScalar());
    }

    private static string StripVersioningBlock(string body) =>
        System.Text.RegularExpressions.Regex.Replace(
            body, "\"Versioning\": \\[[^\\]]*\\]", "\"Versioning\": []");

    [Fact]
    public void PlacementAndCellLocationRows_AreIdentical_TrackedAndUntracked()
    {
        var binaryPlacement = Rows(FromBinary, "placement", "plugin", "origin");
        AssertRowsIdentical("placement", binaryPlacement, Rows(FromSource, "placement", "plugin", "origin"));

        var binaryLocation = Rows(FromBinary, "cell_location", "plugin", "origin");
        AssertRowsIdentical("cell_location", binaryLocation, Rows(FromSource, "cell_location", "plugin", "origin"));

        // Positive controls: two empty tables are trivially equal on both sides.
        Assert.True(binaryPlacement.Count > 0, "fixture produced no placement rows");
        Assert.True(binaryLocation.Count > 0, "fixture produced no cell_location rows");
    }

    [Fact]
    public void FormLookupAndReferenceRows_AreIdentical_TrackedAndUntracked()
    {
        AssertRowsIdentical("form_lookup", Rows(FromBinary, "form_lookup", "plugin", "origin"), Rows(FromSource, "form_lookup", "plugin", "origin"));

        // Hard, and exact: no reference may appear, disappear, or move within its own FieldPath's
        // array ordinal.
        var binaryRefs = Rows(FromBinary, "form_references", "source_plugin", "source_origin");
        AssertRowsIdentical("form_references", binaryRefs, Rows(FromSource, "form_references", "source_plugin", "source_origin"));

        Assert.True(binaryRefs.Count > 0, "fixture produced no form_references rows");
    }

    [Fact]
    public void ContainerChildRows_AreIdentical_TrackedAndUntracked()
    {
        // Hard, and exact: the containment graph may not move, and neither may a child's slot
        // order within it — no allowlist for either kind of divergence.
        var binaryChildren = Rows(FromBinary, "container_child", "plugin", "origin");
        AssertRowsIdentical("container_child", binaryChildren, Rows(FromSource, "container_child", "plugin", "origin"));

        Assert.True(binaryChildren.Count > 0, "fixture produced no container_child rows");
    }

    private List<string> Rows(LoadOrderMirror mirror, string table, string pluginColumn, string originColumn)
    {
        using var cmd = ((DuckDbRecordIndex)mirror.Index!).Connection.CreateCommand();
        cmd.CommandText = $"SELECT * FROM {table} WHERE {pluginColumn} = $1 AND {originColumn} = $2 ORDER BY ALL";
        cmd.Parameters.Add(new DuckDBParameter { Value = Plugin.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = Plugin.Origin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<string>();
        var values = new object[reader.FieldCount];
        while (reader.Read())
        {
            reader.GetValues(values);
            rows.Add(string.Join("|", values.Select(v => Convert.ToString(v, CultureInfo.InvariantCulture))));
        }
        return rows;
    }

    private static void AssertRowsIdentical(string table, List<string> binary, List<string> source)
    {
        var firstDifference = binary.Zip(source).FirstOrDefault(pair => pair.First != pair.Second);
        Assert.True(binary.SequenceEqual(source),
            $"{table} differs: {binary.Count} binary rows vs {source.Count} source rows; " +
            $"first difference binary=[{firstDifference.First}] source=[{firstDifference.Second}]");
    }
}
