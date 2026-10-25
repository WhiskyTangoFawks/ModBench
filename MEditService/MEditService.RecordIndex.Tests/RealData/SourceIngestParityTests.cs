using System.Text;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.RealData;

public sealed class SourceIngestParityTests(SourceParityFixture fixture) : IClassFixture<SourceParityFixture>
{
    [Fact]
    public void TheCompiledPluginReallyIngestedFromSource_NotViaTheBinaryFallback()
    {
        Assert.True(fixture.FromSource.ReadFromItsPluginSource(fixture.Plugin));
    }

    [Fact]
    public void AFreshlyIngestedRealPlugin_ValidatesClean_AndAnnouncesNothingOfIt()
    {
        using var scratch = new ScratchDirectory("medit-source-parity-validates-");
        var partnerPath = Path.Combine(scratch, "Partner.esp");
        PluginBinaries.Rewrite(partnerPath, mod => mod.Npcs.AddNew("PartnerNpc"));
        var partner = new LoadOrderEntry("Partner.esp", partnerPath, "PartnerMod", 1, Enabled: true, Winning: true);
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(
            scratch,
            [
                new LoadOrderEntry(RealDataPlugin.PluginFileName, Path.Combine(fixture.ModFolder, RealDataPlugin.PluginFileName), SourceParityFixture.Origin, 0, Enabled: true, Winning: true),
                partner,
            ],
            Directory.CreateDirectory(Path.Combine(scratch, "instance")).FullName,
            notifications: notifications);

        var announced = index.AnnouncedByEqualArrivals(notifications, () => Announcements.Touched(partner));

        Assert.All(announced, n => Assert.True(Announcements.PluginChanged(partner)(n)));
        Assert.Empty(index.Status.Failures);
    }

    [Fact]
    public void TheSameRecordsExist_CompiledPluginAndNonCompiledPlugin()
    {
        var binary = AllFormKeysInOneUnpagedQuery(fixture.BinaryInstanceRoot).ToHashSet(StringComparer.Ordinal);
        var source = AllFormKeysInOneUnpagedQuery(fixture.SourceInstanceRoot).ToHashSet(StringComparer.Ordinal);

        Assert.True(binary.Count > 2000, $"fixture looks wrong: only {binary.Count} records");
        Assert.Equal(binary.Count, source.Count);
        Assert.Empty(binary.Except(source, StringComparer.Ordinal));
        Assert.Empty(source.Except(binary, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryRecordsDocument_IsByteIdentical_ExceptOnePinnedOverlayVsDeepParseCellDivergence()
    {
        var binaryDocuments = DocumentsByFormKey(fixture.BinaryInstanceRoot);
        var sourceDocuments = DocumentsByFormKey(fixture.SourceInstanceRoot);

        var mismatched = MismatchedFormKeys(binaryDocuments, sourceDocuments);

        Assert.Equal("cell=1", CountsByRecordType(mismatched, binaryDocuments));

        var binaryBody = binaryDocuments[mismatched[0]].Body;
        var sourceBody = sourceDocuments[mismatched[0]].Body;
        Assert.Contains("\"Break2\"", binaryBody, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Break2\"", sourceBody, StringComparison.Ordinal);
        Assert.Equal(StripVersioningBlock(binaryBody), StripVersioningBlock(sourceBody));
    }

    [Fact]
    public void TheHeaderRow_IsByteIdentical_CompiledPluginAndNonCompiledPlugin_AndToTheTreesOwnFile()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(RealDataPlugin.PluginFileName));

        Assert.Equal(PluginHeader.RecordType, fixture.FromBinary.DocumentOf(headerFormKey, fixture.Plugin).RecordType);
        Assert.Equal(PluginHeader.RecordType, fixture.FromSource.DocumentOf(headerFormKey, fixture.Plugin).RecordType);

        var binaryBody = fixture.FromBinary.BodyOf(headerFormKey, fixture.Plugin);
        var sourceBody = fixture.FromSource.BodyOf(headerFormKey, fixture.Plugin);
        Assert.Contains("\"ModHeader\"", binaryBody, StringComparison.Ordinal);

        Assert.Equal(binaryBody, sourceBody);

        var headerFile = Path.Combine(fixture.ModFolder, PluginSourceRoot.HeaderDocument(RealDataPlugin.PluginFileName));
        Assert.True(File.Exists(headerFile), $"expected the compiled plugin tree to hold {headerFile}");
        Assert.Equal(File.ReadAllBytes(headerFile), Encoding.UTF8.GetBytes(sourceBody));
    }

    [Theory]
    [InlineData("holdings")]
    [InlineData("cell_location")]
    [InlineData("form_references")]
    public void ASideTablesRows_AreIdentical_CompiledPluginAndNonCompiledPlugin(string relation)
    {
        var binary = RowsOf(fixture.BinaryInstanceRoot, relation);
        var source = RowsOf(fixture.SourceInstanceRoot, relation);

        Assert.True(binary.Count > 0, $"the fixture produced no {relation} rows");
        var onlyBinary = binary.Except(source, StringComparer.Ordinal).ToList();
        var onlySource = source.Except(binary, StringComparer.Ordinal).ToList();
        Assert.True(
            binary.SequenceEqual(source, StringComparer.Ordinal),
            $"{relation}: {binary.Count} rows from the plugin file, {source.Count} from plugin source." +
            $"\nOnly plugin file:\n{string.Join('\n', onlyBinary.Take(20))}\nOnly plugin source:\n{string.Join('\n', onlySource.Take(20))}");
    }

    private static IEnumerable<string> AllFormKeysInOneUnpagedQuery(string instanceRoot) =>
        IndexFiles.Rows(instanceRoot, "SELECT form_key FROM records").Select(row => row[0]);

    private static Dictionary<string, (string RecordType, string Body)> DocumentsByFormKey(string instanceRoot) =>
        IndexFiles.Rows(instanceRoot, "SELECT form_key, record_type, body FROM records")
            .ToDictionary(row => row[0], row => (row[1], row[2]), StringComparer.Ordinal);

    private static List<string> MismatchedFormKeys(
        Dictionary<string, (string RecordType, string Body)> binaryDocuments,
        Dictionary<string, (string RecordType, string Body)> sourceDocuments) =>
        [.. binaryDocuments
            .Where(binary => !sourceDocuments.TryGetValue(binary.Key, out var source) || binary.Value.Body != source.Body)
            .Select(binary => binary.Key)];

    private static string CountsByRecordType(
        List<string> formKeys, Dictionary<string, (string RecordType, string Body)> documents) =>
        string.Join(", ", formKeys
            .GroupBy(formKey => documents[formKey].RecordType, StringComparer.Ordinal)
            .OrderByDescending(group => group.Count())
            .Select(group => $"{group.Key}={group.Count()}"));

    private static string StripVersioningBlock(string body) =>
        Regex.Replace(body, "\"Versioning\": \\[[^\\]]*\\]", "\"Versioning\": []");

    private static List<string> RowsOf(string instanceRoot, string relation) =>
        [.. IndexFiles.Rows(instanceRoot, $"SELECT * FROM {relation}").Select(row => string.Join(" | ", row))];
}
