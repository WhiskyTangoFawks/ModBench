using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public class SelectTests(TestPluginFixture fixture)
{
    private OpenedIndex LoadedIndex() => Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

    [Fact]
    public void ASelect_ReturnsEachRowItSelectsWithItsColumnsNamed()
    {
        using var index = LoadedIndex();

        var rows = index.Queries.SelectRows("SELECT form_key, editor_id FROM npc_ WHERE editor_id = 'TestNPC01'").Value().Rows;

        var row = Assert.Single(rows);
        Assert.Equal("TestNPC01", row.GetProperty("editor_id").GetString());
        Assert.Equal(fixture.Npc1FormKey.ToString(), row.GetProperty("form_key").GetString());
    }

    [Fact]
    public void ASelect_ReturnsEveryRowTheViewHolds()
    {
        using var index = LoadedIndex();

        Assert.Equal(TestPluginFixture.RecordCount, index.Queries.SelectRows("SELECT form_key FROM npc_").Value().Rows.Length);
    }

    [Fact]
    public void ASelect_NeedsNoFormKeyColumn()
    {
        using var index = LoadedIndex();

        Assert.Equal(TestPluginFixture.RecordCount, index.Queries.SelectRows("SELECT count(*) AS n FROM npc_").Value().Rows.Single().GetProperty("n").GetInt32());
    }

    [Fact]
    public void ASelect_IsNotNarrowedByTheRecordFilterInForce()
    {
        using var index = LoadedIndex();
        index.SetFilter("SELECT 'NonExistentFormKey:000000' AS form_key", "filter.sql");

        Assert.Equal(TestPluginFixture.RecordCount, index.Queries.SelectRows("SELECT form_key FROM npc_").Value().Rows.Length);
    }

    [Fact]
    public void ASelect_LeavesTheRecordFilterInForceStanding()
    {
        using var index = LoadedIndex();
        index.SetFilter("SELECT 'NonExistentFormKey:000000' AS form_key", "kept.sql");

        index.Queries.SelectRows("SELECT form_key FROM npc_").Value();

        Assert.Equal("kept.sql", index.Queries.GetFilter().Value()?.Source);
    }

    [Theory]
    [InlineData("DROP VIEW npc_", "")]
    [InlineData("SELECT form_key FROM npc_ WHERE no_such_column = 1", "no_such_column")]
    public void ASelectDuckDbOrANonSelectRefuses_IsRefusedSayingWhy(string sql, string reason)
    {
        using var index = LoadedIndex();

        var refused = index.Queries.SelectRows(sql).Refused();

        Assert.Equal(IndexRefusal.SelectRejected, refused.Refusal);
        Assert.Contains(reason, refused.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("SELECT * FROM active_plugins", "active_plugins")]
    [InlineData("SELECT * FROM registrations", "registrations")]
    [InlineData("SELECT * FROM plugin_records", "plugin_records")]
    [InlineData("WITH RECURSIVE sqlite_master AS (SELECT name FROM sqlite_master UNION ALL SELECT name FROM sqlite_master WHERE false) SELECT name FROM sqlite_master", "sqlite_master")]
    [InlineData("SELECT name FROM sqlite_master WHERE name IN (WITH sqlite_master AS (SELECT 'x' AS name) SELECT name FROM sqlite_master)", "sqlite_master")]
    public void ASelectOfAnythingButTheViews_IsRefused_NamingTheRelationAndTheViews(string sql, string relation)
    {
        using var index = LoadedIndex();

        var refused = index.Queries.SelectRows(sql).Refused();

        Assert.Equal(IndexRefusal.SelectRejected, refused.Refusal);
        Assert.Contains($"{relation} is not one", refused.Message, StringComparison.Ordinal);
        Assert.Contains("records, form_references, holdings", refused.Message, StringComparison.Ordinal);
        Assert.Contains("view_columns", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ASelectOfViewColumns_ListsEachViewWithItsColumns()
    {
        using var index = LoadedIndex();

        var columns = index.Queries.SelectRows("SELECT view_name, column_name FROM view_columns").Value().Rows
            .Select(row => (row.GetProperty("view_name").GetString(), row.GetProperty("column_name").GetString())).ToList();

        Assert.Contains(("records", "is_active"), columns);
        Assert.Contains(("npc_", "editor_id"), columns);
        Assert.DoesNotContain(columns, column => column.Item1 == "view_columns");
    }
}
