using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

// ADR-0011: the relational schema is a contract for the SQL door only, and the filter is that
// door. What a filter may name is what these pin.
public sealed class SqlDoorSchemaTests : IDisposable
{
    private static readonly PluginAddress BaseKey = new("Base.esm", "Data");
    private static readonly PluginAddress OverKey = new("Over.esp", "Data");

    private readonly PluginFixtureData _fixture;
    private readonly Indexer _index;
    private readonly string _npc;

    public SqlDoorSchemaTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("sql-door")
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("SharedNpc").FormKey)
            .WithPlugin("Over.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .Build();
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IReadOnlyList<RecordSummary> Listing() =>
        _index.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10)).Items;

    // ADR-0009: load order lives only on the registrations, and the record-type view derives
    // load_order_idx and is_winner by joining them, so a filter can name both.
    [Fact]
    public void ARecordTypeView_ExposesTheIdentityColumns_AndTheDerivedWinnerAndLoadOrder()
    {
        _index.SetFilter("SELECT form_key FROM npc_ WHERE is_winner AND editor_id = 'SharedNpc' AND load_order_idx = 1", "filter.sql");

        var winner = Assert.Single(Listing(), i => i.IsWinner);
        Assert.Equal(OverKey.Name, winner.Plugin);
        Assert.Equal(_npc, winner.FormKey);

        _index.SetFilter("SELECT form_key FROM npc_ WHERE plugin = 'Base.esm' AND NOT is_winner AND load_order_idx = 0", "filter.sql");
        Assert.Contains(Listing(), i => i.Plugin == BaseKey.Name);
    }

    // records and form_lookup answer is_winner and load_order_idx the same derived way; the
    // committed relation carries no winner of its own.
    [Theory]
    [InlineData("records", true)]
    [InlineData("form_lookup", true)]
    [InlineData("records_head", true)]
    [InlineData("records_committed", false)]
    public void ARelation_ExposesWinner_OnlyWhereAReaderAsksForIt(string relation, bool exposesWinner)
    {
        var sql = $"SELECT form_key FROM {relation} WHERE is_winner";

        if (exposesWinner)
        {
            _index.SetFilter(sql, "filter.sql");
            Assert.NotEmpty(Listing());
        }
        else
        {
            Assert.ThrowsAny<Exception>(() => _index.SetFilter(sql, "filter.sql"));
        }
    }

    // records_committed holds only the committed snapshots of records the working tree has moved,
    // so on a clean plugin the column is provable by acceptance alone.
    [Theory]
    [InlineData("records", true)]
    [InlineData("records_committed", false)]
    [InlineData("form_lookup", true)]
    public void ARelation_ExposesLoadOrderIndex(string relation, bool holdsACleanPluginsRows)
    {
        _index.SetFilter($"SELECT form_key FROM {relation} WHERE load_order_idx = 1", "filter.sql");

        if (holdsACleanPluginsRows) Assert.Single(Listing(), i => i.Plugin == OverKey.Name);
        else Assert.Empty(Listing());
    }

    [Fact]
    public void AFilterNamingAnUnknownColumn_IsRefused_AndTheFilterInForceStands()
    {
        _index.SetFilter("SELECT form_key FROM npc_ WHERE plugin = 'Over.esp'", "filter.sql");

        Assert.ThrowsAny<Exception>(() => _index.SetFilter("SELECT form_key FROM npc_ WHERE no_such_column = 1", "filter.sql"));

        Assert.Equal("SELECT form_key FROM npc_ WHERE plugin = 'Over.esp'", _index.FilterSql);
        Assert.Single(Listing(), i => i.Plugin == OverKey.Name);
    }
}
