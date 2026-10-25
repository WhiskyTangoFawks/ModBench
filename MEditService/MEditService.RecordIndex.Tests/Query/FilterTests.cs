using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class FilterTests(TestPluginFixture fixture)
{
    private static readonly PluginAddress Plugin = new(TestPluginFixture.PluginName, PluginOrigin.DataDirectory);

    private readonly TestPluginFixture _fixture = fixture;

    private OpenedIndex LoadedIndex() => Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);

    private static PagedResult<RecordSummary> NpcListing(OpenedIndex index) =>
        index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0).Value();

    private static IEnumerable<PluginAddress> PluginsWithMatches(OpenedIndex index) =>
        index.Queries.GetPlugins().Value().Where(row => row.HasMatchingRecords).Select(row => row.KeyOf());

    [Theory]
    [InlineData("SELECT editor_id FROM \"NPC_\"", "Filter SQL must return a form_key")]
    [InlineData("NOT VALID SQL!!!", "syntax error")]
    [InlineData("SELECT form_key FROM \"NPC_\" WHERE CAST(editor_id AS INTEGER) = 1", "Conversion Error")]
    public void AFilterThatCannotRun_IsRefusedWithDuckDbsReason(string sql, string reasonStart)
    {
        using var index = LoadedIndex();

        var refused = index.Queries.SetFilter(sql, "filter.sql");

        Assert.Equal(IndexRefusal.FilterRejected, refused?.Refusal);
        Assert.StartsWith(reasonStart, refused?.Message);
    }

    [Fact]
    public void ARefusedFilter_LeavesTheFilterInForceStanding()
    {
        using var index = LoadedIndex();
        var firstFormKey = NpcListing(index).Items[0].FormKey;
        index.SetFilter($"SELECT '{firstFormKey}' AS form_key", "kept.sql");

        index.Queries.SetFilter("SELECT editor_id FROM \"NPC_\"", "refused.sql");

        Assert.Equal(("kept.sql", 1), (index.Queries.GetFilter().Value()?.Source, NpcListing(index).Total));
    }

    [Fact]
    public void AnActiveFilter_NarrowsTheListingToItsMatches_WhateverExtraColumnsItSelects()
    {
        using var index = LoadedIndex();
        var all = NpcListing(index);
        Assert.Equal(TestPluginFixture.RecordCount, all.Total);

        var firstFormKey = all.Items[0].FormKey;
        index.SetFilter($"SELECT '{firstFormKey}' AS form_key, 'x' AS plugin", "filter.sql");

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
        Assert.Contains(Plugin, PluginsWithMatches(index));
    }

    [Fact]
    public void ASearch_IsNotNarrowedByTheRecordFilter()
    {
        using var index = LoadedIndex();
        index.SetFilter($"SELECT '{_fixture.Npc1FormKey}' AS form_key", "filter.sql");

        var found = index.Queries.GetRecords(["npc_"], plugin: null, search: "TestNPC02", limit: 100, offset: 0).Value();

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
    public void NoMatchingRecords_FlagsNoPluginAsMatching_ButKeepsEveryPluginListed_ForTheTreeIsAlsoTheLoadOrder()
    {
        using var index = LoadedIndex();
        index.SetFilter("SELECT 'NonExistentFormKey:000000' AS form_key", "filter.sql");

        Assert.Empty(PluginsWithMatches(index));
        Assert.Contains(index.Queries.GetPlugins().Value(), row => row.KeyOf() == Plugin);
    }
}
