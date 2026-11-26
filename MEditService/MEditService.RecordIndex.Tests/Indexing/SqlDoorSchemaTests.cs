using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class SqlDoorSchemaTests(SqlDoorSchemaTests.TwoCopies copies) : IClassFixture<SqlDoorSchemaTests.TwoCopies>
{
    private static readonly PluginAddress BaseKey = new("Base.esm", PluginOrigin.DataDirectory);
    private static readonly PluginAddress OverKey = new("Over.esp", PluginOrigin.DataDirectory);

    /// <summary>Base.esm's NPC and Over.esp's copy of it, indexed once: each test sets the filter it reads under.</summary>
    public sealed class TwoCopies : IDisposable
    {
        private readonly PluginFixtureData _fixture;

        public TwoCopies()
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
            Npc = npc.ToString();
            Index = Indexes.Reconciled(_fixture);
        }

        internal OpenedIndex Index { get; }

        internal string Npc { get; }

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }

    private readonly OpenedIndex _index = copies.Index;

    private IReadOnlyList<RecordSummary> Listing() =>
        _index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Items;

    [Fact]
    public void ARecordTypeView_ExposesTheIdentityColumns_AndTheDerivedWinnerAndLoadOrder()
    {
        _index.SetFilter("SELECT form_key FROM npc_ WHERE is_winner AND editor_id = 'SharedNpc' AND load_order_idx = 1", "filter.sql");

        var winner = Assert.Single(Listing(), i => i.IsWinner);
        Assert.Equal(OverKey.Name, winner.Plugin);
        Assert.Equal(copies.Npc, winner.FormKey);

        _index.SetFilter("SELECT form_key FROM npc_ WHERE plugin = 'Base.esm' AND NOT is_winner AND load_order_idx = 0", "filter.sql");
        Assert.Contains(Listing(), i => i.Plugin == BaseKey.Name);
    }

    [Fact]
    public void ARecordTypeView_SpellsTheEditorIdOnce_AsEditorId()
    {
        _index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'SharedNpc'", "filter.sql");
        Assert.Equal(2, Listing().Count);

        var unbound = _index.Queries.SetFilter("SELECT form_key FROM npc_ WHERE \"EditorID\" = 'SharedNpc'", "filter.sql");
        Assert.Equal(IndexRefusal.FilterRejected, unbound?.Refusal);
        Assert.Contains("Referenced column \"EditorID\" not found", unbound?.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("records")]
    [InlineData("form_lookup")]
    public void ARelationAReaderAsksTheWinnerOf_ExposesItAndTheLoadOrderIndex(string relation)
    {
        _index.SetFilter($"SELECT form_key FROM {relation} WHERE is_winner AND load_order_idx = 1", "filter.sql");

        Assert.Single(Listing(), i => i.Plugin == OverKey.Name);
    }

    [Theory]
    [InlineData("SELECT child AS form_key FROM holdings WHERE is_winner", "is_winner")]
    [InlineData("SELECT form_key FROM records WHERE copy_id >= 0", "copy_id")]
    public void ARelation_ExposesNoColumnThatIsNotItsOwn(string filter, string column)
    {
        var refused = _index.Queries.SetFilter(filter, "filter.sql");

        Assert.Equal(IndexRefusal.FilterRejected, refused?.Refusal);
        Assert.Contains($"\"{column}\" not found", refused?.Message, StringComparison.Ordinal);
    }
}
