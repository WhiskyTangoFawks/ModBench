using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Index.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class FilterTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private IndexProjector LoadedIndex() => Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);

    // --- SetFilter: validation ---

    [Fact]
    public void SetFilter_ValidSqlWithExtraColumns_FiltersByFormKey()
    {
        // A filter projecting extra columns beyond form_key is accepted and still filters.
        using var index = LoadedIndex();
        var reads = index.RequireReads();
        var all = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key, 'x' AS plugin");

        var filtered = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    [Fact]
    public void SetFilter_SqlWithoutFormKeyColumn_ThrowsArgumentException()
    {
        using var index = LoadedIndex();
        var ex = Assert.Throws<ArgumentException>(() =>
            index.SetFilter("SELECT editor_id FROM \"NPC_\""));
        Assert.Contains("form_key", ex.Message);
    }

    [Fact]
    public void SetFilter_BadSyntax_ThrowsException()
    {
        using var index = LoadedIndex();
        Assert.ThrowsAny<Exception>(() => index.SetFilter("NOT VALID SQL!!!"));
    }

    // --- SetFilter: filter injection into Search ---

    [Fact]
    public void GetRecords_WithActiveFilter_ReturnsOnlyMatchingRecords()
    {
        using var index = LoadedIndex();
        var reads = index.RequireReads();
        var all = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        // filter to first record only
        var firstFormKey = all.Items[0].FormKey;
        index.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var filtered = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    [Fact]
    public void GetRecords_AfterClearFilter_ReturnsAllRecords()
    {
        using var index = LoadedIndex();
        var reads = index.RequireReads();
        var all = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key");
        index.ClearFilter();

        var restored = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, restored.Total);
    }

    [Fact]
    public void SearchRecords_WithActiveFilter_ReturnsOnlyMatchingRecords()
    {
        using var index = LoadedIndex();
        var reads = index.RequireReads();
        var all = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        var firstFormKey = all.Items[0].FormKey;
        index.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var filtered = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    // --- SetFilter: filter injection into GetRecordTypeCounts ---

    [Fact]
    public void CountRecordsForPlugin_WithActiveFilter_CountsOnlyMatching()
    {
        using var index = LoadedIndex();
        var reads = index.RequireReads();
        var all = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        Assert.Equal(1, reads.CountOf(new PluginCopyKey(TestPluginFixture.PluginName, "Data"), "NPC_"));
    }

    // --- GetPluginsWithMatchingRecords ---

    [Fact]
    public void GetPluginsWithMatchingRecords_WithActiveFilter_ReturnsPluginWithMatches()
    {
        using var index = LoadedIndex();
        var reads = index.RequireReads();
        var all = reads.Search(new RecordQuery(RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        var firstFormKey = all.Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key");

        var plugins = reads.GetPluginsWithMatchingRecords(["NPC_"]);
        Assert.Contains(TestPluginFixture.PluginName, plugins);
    }

    [Fact]
    public void GetPluginsWithMatchingRecords_NoMatchingRecords_ReturnsEmpty()
    {
        using var index = LoadedIndex();
        index.SetFilter("SELECT 'NonExistentFormKey:000000' AS form_key");

        var plugins = index.RequireReads().GetPluginsWithMatchingRecords(["NPC_"]);
        Assert.Empty(plugins);
    }

    [Fact]
    public void GetPluginsWithMatchingRecords_EmptyTableList_ReturnsEmpty()
    {
        using var index = LoadedIndex();
        index.SetFilter($"SELECT form_key FROM \"NPC_\"");

        var plugins = index.RequireReads().GetPluginsWithMatchingRecords([]);
        Assert.Empty(plugins);
    }
}
