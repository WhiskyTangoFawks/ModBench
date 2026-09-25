using System.Text;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.RealData;

/// <summary>Both ingest paths land the same rows over the same mod shape, so there is no second
/// extraction to drift; this checks it on 3,940 authentic records.</summary>
public sealed class SourceIngestParityTests(SourceParityFixture fixture) : IClassFixture<SourceParityFixture>
{
    [Fact]
    public void TheTrackedPluginReallyIngestedFromSource_NotViaTheBinaryFallback()
    {
        Assert.Empty(fixture.FromSource.Status.Failures);
        Assert.True(SourceRepository.HoldsTreeFor(fixture.ModFolder, RealDataPlugin.PluginFileName));
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
        foreach (var type in (string[])["refr", "achr", "navm", "land", "cell", "pgre", "pmis", "phzd"])
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
        var binaryBody = binaryDocuments[mismatched[0]].BodyOf();
        var sourceBody = sourceDocuments[mismatched[0]].BodyOf();
        Assert.Contains("\"Break2\"", binaryBody, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Break2\"", sourceBody, StringComparison.Ordinal);
        Assert.Equal(StripVersioningBlock(binaryBody), StripVersioningBlock(sourceBody));
    }

    [Fact]
    public void TheHeaderRow_IsByteIdentical_TrackedAndUntracked()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(RealDataPlugin.PluginFileName));

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

        // The third arm: against the tracked plugin's own file on disk, as raw bytes. A document's
        // body is text, so this is the only comparison here that is genuinely about bytes.
        var headerFile = Path.Combine(fixture.ModFolder, "source", RealDataPlugin.PluginFileName, "RecordData.json");
        Assert.True(File.Exists(headerFile), $"expected the tracked tree to hold {headerFile}");
        Assert.Equal(File.ReadAllBytes(headerFile), Encoding.UTF8.GetBytes(source.BodyOf()));
    }

    [Fact]
    public void PlacementAndCellLocationRows_AreIdentical_TrackedAndUntracked()
    {
        var keys = AllFormKeys(fixture.FromBinary);
        var placed = 0;
        var located = 0;
        foreach (var formKey in keys)
        {
            var binaryPlacement = fixture.FromBinary.RequireReads().GetPlacement(formKey, fixture.Plugin);
            Assert.Equal(binaryPlacement, fixture.FromSource.RequireReads().GetPlacement(formKey, fixture.Plugin));
            if (binaryPlacement is not null) placed++;

            var binaryLocation = fixture.FromBinary.RequireReads().GetCellLocation(fixture.Plugin, formKey);
            Assert.Equal(binaryLocation, fixture.FromSource.RequireReads().GetCellLocation(fixture.Plugin, formKey));
            if (binaryLocation is not null) located++;
        }

        // Positive controls: two empty answers are trivially equal on both sides.
        Assert.True(placed > 0, "fixture produced no placements");
        Assert.True(located > 0, "fixture produced no cell locations");
    }

    [Fact]
    public void FormLookupAndReferenceRows_AreIdentical_TrackedAndUntracked()
    {
        var referenced = 0;
        foreach (var formKey in AllFormKeys(fixture.FromBinary))
        {
            Assert.Equal(
                fixture.FromBinary.RequireReads().Resolve(formKey),
                fixture.FromSource.RequireReads().Resolve(formKey));

            var binaryReferences = Ordered(fixture.FromBinary.RequireReads().GetReferencedBy(formKey));
            Assert.Equal(binaryReferences, Ordered(fixture.FromSource.RequireReads().GetReferencedBy(formKey)));
            referenced += binaryReferences.Count;
        }

        Assert.True(referenced > 0, "fixture produced no references");
    }

    [Fact]
    public void ContainerChildRows_AreIdentical_TrackedAndUntracked()
    {
        var children = 0;
        foreach (var formKey in AllFormKeys(fixture.FromBinary))
        {
            var binaryChildren = fixture.FromBinary.RequireReads().GetContainerChildren(fixture.Plugin, formKey);
            Assert.Equal(binaryChildren, fixture.FromSource.RequireReads().GetContainerChildren(fixture.Plugin, formKey));
            Assert.Equal(
                fixture.FromBinary.RequireReads().GetContainerParent(fixture.Plugin, formKey),
                fixture.FromSource.RequireReads().GetContainerParent(fixture.Plugin, formKey));
            children += binaryChildren.Count;
        }

        Assert.True(children > 0, "fixture produced no container children");
    }

    // One unpaged query: Search orders by editor_id, which is non-unique and null for every placed
    // ref, so LIMIT/OFFSET pages silently skip and repeat rows.
    private List<string> AllFormKeys(Indexer index) =>
        [.. index.RequireReads()
            .Search(new RecordQuery(Plugin: fixture.Plugin.Name, Origin: fixture.Plugin.Origin, Limit: int.MaxValue))
            .Items.Select(i => i.FormKey)];

    private int CountOf(Indexer index, string recordType) =>
        index.RequireReads().CountOf(fixture.Plugin, recordType);

    private Dictionary<string, RecordDocument> DocumentsByFormKey(Indexer index) =>
        index.RequireReads().GetDocuments(fixture.Plugin).ToDictionary(d => d.FormKey, StringComparer.Ordinal);

    private static List<ReferenceResult> Ordered(IEnumerable<ReferenceResult> references) =>
        [.. references.OrderBy(r => r.FormKey, StringComparer.Ordinal).ThenBy(r => r.FieldPath, StringComparer.Ordinal)];

    private static string StripVersioningBlock(string body) =>
        Regex.Replace(body, "\"Versioning\": \\[[^\\]]*\\]", "\"Versioning\": []");
}
