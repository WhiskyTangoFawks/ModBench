using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class FilterTests(TestPluginFixture fixture)
{
    private static readonly PluginAddress Plugin = new(TestPluginFixture.PluginName, PluginOrigin.DataDirectory);

    private readonly TestPluginFixture _fixture = fixture;

    private OpenedIndex LoadedIndex() => Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);

    private static PagedResult<RecordSummary> NpcListing(OpenedIndex index) =>
        index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0);

    private static IEnumerable<PluginAddress> PluginsWithMatches(OpenedIndex index) =>
        index.Records.GetPlugins().Where(row => row.HasMatchingRecords).Select(row => row.Plugin.Key);

    [Fact]
    public void SetFilter_ValidSqlWithExtraColumns_FiltersByFormKey()
    {
        using var index = LoadedIndex();
        var firstFormKey = NpcListing(index).Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key, 'x' AS plugin", "filter.sql");

        var filtered = NpcListing(index);
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    [Fact]
    public void SetFilter_SqlWithoutFormKeyColumn_ThrowsArgumentException()
    {
        using var index = LoadedIndex();
        var ex = Assert.Throws<ArgumentException>(() =>
            index.SetFilter("SELECT editor_id FROM \"NPC_\"", "filter.sql"));
        Assert.Contains("form_key", ex.Message);
    }

    [Fact]
    public void SetFilter_BadSyntax_ThrowsException()
    {
        using var index = LoadedIndex();
        Assert.ThrowsAny<Exception>(() => index.SetFilter("NOT VALID SQL!!!", "filter.sql"));
    }

    [Fact]
    public void AnActiveFilter_NarrowsTheListingToItsMatches()
    {
        using var index = LoadedIndex();
        var all = NpcListing(index);
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        var firstFormKey = all.Items[0].FormKey;
        index.SetFilter($"SELECT '{firstFormKey}' AS form_key", "filter.sql");

        var filtered = NpcListing(index);
        Assert.Equal(1, filtered.Total);
        Assert.Equal(firstFormKey, filtered.Items[0].FormKey);
    }

    [Fact]
    public void ClearingTheFilter_RestoresTheFullListing()
    {
        using var index = LoadedIndex();
        var firstFormKey = NpcListing(index).Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key", "filter.sql");
        index.ClearFilter();

        Assert.Equal(TestPluginFixture.RecordCount, NpcListing(index).Total);
    }

    [Fact]
    public void ASearch_IsNotNarrowedByTheRecordFilter()
    {
        using var index = LoadedIndex();
        index.SetFilter($"SELECT '{_fixture.Npc1FormKey}' AS form_key", "filter.sql");

        var found = index.Records.GetRecords(["npc_"], plugin: null, search: "TestNPC02", limit: 100, offset: 0);

        Assert.Equal(["TestNPC02"], found.Items.Select(r => r.EditorId));
    }

    [Fact]
    public void AnActiveFilter_NarrowsAPluginsCountToItsMatches()
    {
        using var index = LoadedIndex();
        var firstFormKey = NpcListing(index).Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key", "filter.sql");

        Assert.Equal(1, index.CountOf(Plugin, "npc_"));
    }

    [Fact]
    public void AnActiveFilter_ListsThePluginsWithMatches()
    {
        using var index = LoadedIndex();
        var firstFormKey = NpcListing(index).Items[0].FormKey;

        index.SetFilter($"SELECT '{firstFormKey}' AS form_key", "filter.sql");

        Assert.Contains(Plugin, PluginsWithMatches(index));
    }

    [Fact]
    public void TwoPluginsOfOneName_OnlyThePluginThatMatchesIsListed()
    {
        using var plugins = new PluginFixtureBuilder("filter-two-plugins")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("InBoth"), origin: "ModA")
            .WithPlugin("Shared.esp", mod =>
            {
                mod.Npcs.AddNew("InBoth");
                mod.Npcs.AddNew("OnlyInModB");
            }, origin: "ModB")
            .BuildScattered();
        using var index = Indexes.Reconciled(plugins);

        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'OnlyInModB'", "filter.sql");

        Assert.Equal([new PluginAddress("Shared.esp", "ModB")], PluginsWithMatches(index));
    }

    [Fact]
    public void NoMatchingRecords_ListsNoPlugin()
    {
        using var index = LoadedIndex();
        index.SetFilter("SELECT 'NonExistentFormKey:000000' AS form_key", "filter.sql");

        Assert.Empty(PluginsWithMatches(index));
    }
}
