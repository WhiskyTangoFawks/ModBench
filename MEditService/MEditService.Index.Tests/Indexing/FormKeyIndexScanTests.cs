using DuckDB.NET.Data;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

public sealed class FormKeyIndexScanTests : IDisposable
{
    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-index-scan-").FullName;
    private readonly PluginFixtureData _fixture;
    private readonly Indexer _index;

    public FormKeyIndexScanTests()
    {
        _fixture = new PluginFixtureBuilder("form-key-index-scan")
            .WithPlugin("Scan.esp", mod => mod.Npcs.AddNew("ScanNpc"))
            .Build();
        _index = Indexes.Reconciled(_fixture, _instanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
        Directory.Delete(_instanceRoot, recursive: true);
    }

    private string PlanOf(string sql)
    {
        using var connection = new DuckDBConnection($"Data Source={IndexFiles.In(_instanceRoot)}");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"EXPLAIN ANALYZE {sql}";
        using var reader = cmd.ExecuteReader();
        var plan = new System.Text.StringBuilder();
        while (reader.Read()) plan.Append(reader.GetString(1));
        return plan.ToString();
    }

    [Theory]
    [InlineData("records", "form_key")]
    [InlineData("records_committed", "form_key")]
    [InlineData("form_lookup", "form_key")]
    [InlineData("form_references", "target_form_key")]
    public void APointLookupByFormKey_ReadsTheIndex(string table, string column)
    {
        var plan = PlanOf($"SELECT * FROM mirror.{table} WHERE {column} = '000800:Scan.esp'");

        Assert.Contains("Index Scan", plan);
    }
}
