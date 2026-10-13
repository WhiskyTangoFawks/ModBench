using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Indexing;

public sealed class SqlDoorSealTests(SqlDoorFixture fixture) : IClassFixture<SqlDoorFixture>
{
    [Theory]
    [InlineData("SELECT form_key FROM mirror.records")]
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
    [InlineData("SELECT form_key FROM main.npc_")]
    [InlineData("WITH held AS (SELECT form_key FROM records) SELECT form_key FROM held")]
    [InlineData("SELECT form_key FROM records, unnest([1, 2]) AS t(n)")]
    public void AFilterOfThePublicRelations_IsAccepted(string sql) => Assert.True(fixture.Index.Accepts(sql));
}
