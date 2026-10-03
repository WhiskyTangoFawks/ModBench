using MEditService.Index.Tests.TestSupport;

namespace MEditService.Index.Tests.Indexing;

public sealed class SqlDoorSealTests(SqlDoorFixture fixture) : IClassFixture<SqlDoorFixture>
{
    [Theory]
    [InlineData("SELECT form_key FROM mirror.records")]
    [InlineData("SELECT form_key FROM mirror.records_committed")]
    [InlineData("SELECT form_key FROM mirror.head_rows")]
    [InlineData("SELECT form_key FROM records WHERE form_key IN (SELECT form_key FROM mirror.records)")]
    [InlineData("SELECT table_name AS form_key FROM information_schema.tables")]
    [InlineData("SELECT form_key FROM query('SELECT form_key FROM mirror.records')")]
    [InlineData("SELECT form_key FROM query_table('mirror.records')")]
    [InlineData("SELECT table_name AS form_key FROM duckdb_tables()")]
    [InlineData("SELECT form_key FROM records; SELECT form_key FROM mirror.records")]
    public void AFilterThatReachesPastThePublicRelations_IsRefused(string sql) =>
        Assert.False(fixture.Index.Accepts(sql));

    [Theory]
    [InlineData("SELECT form_key FROM records")]
    [InlineData("SELECT form_key FROM main.npc_")]
    [InlineData("WITH held AS (SELECT form_key FROM records) SELECT form_key FROM held")]
    [InlineData("SELECT form_key FROM records, unnest([1, 2]) AS t(n)")]
    public void AFilterOfThePublicRelations_IsAccepted(string sql) => Assert.True(fixture.Index.Accepts(sql));
}
