using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class SqlDoorSealTests(SqlDoorFixture fixture) : IClassFixture<SqlDoorFixture>
{
    [Theory]
    [InlineData("SELECT form_key FROM mirror.records")]
    [InlineData("SELECT form_key FROM main.npc_")]
    [InlineData("SELECT form_key FROM winners")]
    [InlineData("(WITH plugin_records AS (SELECT 1 AS form_key) SELECT form_key FROM plugin_records) UNION ALL SELECT form_key FROM plugin_records")]
    [InlineData("WITH winners AS (SELECT form_key FROM winners) SELECT form_key FROM winners")]
    [InlineData("WITH RECURSIVE winners AS (SELECT form_key FROM winners UNION ALL SELECT form_key FROM winners WHERE false) SELECT form_key FROM winners")]
    [InlineData("SELECT name AS form_key FROM sqlite_master")]
    [InlineData("SELECT form_key FROM records WHERE form_key IN (SELECT form_key FROM mirror.records)")]
    [InlineData("SELECT table_name AS form_key FROM information_schema.tables")]
    [InlineData("SELECT form_key FROM query('SELECT form_key FROM mirror.records')")]
    [InlineData("SELECT form_key FROM query_table('mirror.records')")]
    [InlineData("SELECT table_name AS form_key FROM duckdb_tables()")]
    [InlineData("SELECT form_key FROM records; SELECT form_key FROM mirror.records")]
    public void AFilterThatReachesPastThePublicRelations_IsRefused(string sql) =>
        Assert.False(fixture.Index.Accepts(sql));

    [Fact]
    public void ASelectFromAFile_IsRefused_ForItReadsNoRecordView()
    {
        using var scratch = new ScratchDirectory("sealed-");
        var file = Path.Combine(scratch, "sealed.csv");
        File.WriteAllText(file, "form_key\nsecret\n");

        Assert.False(fixture.Index.Accepts($"SELECT form_key FROM '{file}'"));
        Assert.Contains("file", fixture.Index.Queries.SelectRows($"SELECT form_key FROM '{file}'").Refused().Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ASelectEndingInASemicolon_IsAnswered()
    {
        Assert.Single(fixture.Index.Queries.SelectRows("SELECT 1 AS n;").Value());
    }

    [Theory]
    [InlineData("SELECT form_key FROM records")]
    [InlineData("WITH held AS (SELECT form_key FROM records) SELECT form_key FROM held")]
    [InlineData("WITH a AS (SELECT form_key FROM records), b AS (SELECT form_key FROM a) SELECT form_key FROM b")]
    [InlineData("WITH RECURSIVE r(form_key) AS (SELECT form_key FROM records UNION SELECT form_key FROM r) SELECT form_key FROM r")]
    [InlineData("SELECT form_key FROM records, unnest([1, 2]) AS t(n)")]
    public void AFilterOfThePublicRelations_IsAccepted(string sql) => Assert.True(fixture.Index.Accepts(sql));
}
