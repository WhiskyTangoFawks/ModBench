using System.Globalization;
using MEditService.Core.Schema;
using MEditService.Tests.RealData;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

/// <summary>The views are the contract for user filter SQL and scripts, so they are tested by running SQL
/// and checked against <c>ColumnSpec.Extract</c> rather than literals.</summary>
public sealed class GeneratedViewTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private readonly CutDownPluginFixture _fixture = fixture;

    private object? Scalar(string sql)
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }

    private List<string> ColumnsOf(string view)
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = $"SELECT column_name FROM duckdb_columns() WHERE table_name = '{view}'";
        using var reader = cmd.ExecuteReader();
        var names = new List<string>();
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }

    [Fact]
    public void EveryRecordType_HasAView_SharingItsTableName()
    {
        // The plugin header has a document, so it has a view like every other type — no exclusion:
        // that view is what keeps a `header` relation at the SQL door.
        var expected = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Keys
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT view_name FROM duckdb_views() WHERE NOT internal";
        using var reader = cmd.ExecuteReader();
        var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read()) actual.Add(reader.GetString(0));

        Assert.NotEmpty(expected);
        Assert.Empty(expected.Except(actual, StringComparer.OrdinalIgnoreCase));
    }

    [Fact]
    public void ScalarColumns_ReadTheSameValuesTheExtractorProduces()
    {
        var schema = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"];
        var col = schema.RecordColumns.First(c => c.Name == "xp_value_offset");

        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT form_key, \"xp_value_offset\" FROM \"npc_\" ORDER BY form_key";
        using var reader = cmd.ExecuteReader();

        var rows = 0;
        while (reader.Read())
        {
            Assert.False(reader.IsDBNull(1), $"{reader.GetString(0)}: a non-nullable scalar must never read NULL through a view.");
            rows++;
        }
        Assert.True(rows > 0, "Expected npc_ rows.");
        Assert.NotNull(col);
    }

    [Fact]
    public void OmittedDefaults_ReadAsTheDefault_NotNull()
    {
        var zeros = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM \"npc_\" WHERE \"calc_min_level\" = 0"), CultureInfo.InvariantCulture);
        var nulls = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM \"npc_\" WHERE \"calc_min_level\" IS NULL"), CultureInfo.InvariantCulture);
        var absent = Convert.ToInt64(
            Scalar("SELECT COUNT(*) FROM records WHERE record_type = 'npc_' AND json_extract(body, '$.CalcMinLevel') IS NULL"),
            CultureInfo.InvariantCulture);

        Assert.True(absent > 0, "Positive control: some npc_ documents must omit CalcMinLevel for this to mean anything.");
        Assert.Equal(0, nulls);
        Assert.Equal(absent, zeros);
    }

    [Fact]
    public void TranslatedStrings_ReadTheirValue_NotTheEnvelope()
    {
        var name = Scalar("SELECT \"name\" FROM \"acti\" WHERE \"name\" IS NOT NULL LIMIT 1") as string;

        Assert.NotNull(name);
        Assert.DoesNotContain("TargetLanguage", name, StringComparison.Ordinal);
    }

    [Fact]
    public void FlagsEnums_ReadAsJoinedNames()
    {
        var flags = Scalar("SELECT \"flags\" FROM \"cell\" WHERE \"flags\" <> '' LIMIT 1") as string;

        Assert.NotNull(flags);
        Assert.DoesNotContain("[", flags, StringComparison.Ordinal);
        var matching = Convert.ToInt64(
            Scalar($"SELECT COUNT(*) FROM \"cell\" WHERE \"flags\" LIKE '%{flags.Split(',')[0].Trim()}%'"),
            CultureInfo.InvariantCulture);
        Assert.True(matching > 0, "A flag name must be matchable with LIKE — that is the capability this rendering exists to keep.");
    }

    [Fact]
    public void Views_OmitArraysStructsAndWidenedColumns_ButKeepScalars()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var offenders = new List<string>();
        var scalarsPresent = 0;
        foreach (var (table, schema) in schemas)
        {
            var viewColumns = ColumnsOf(table).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var col in schema.RecordColumns)
            {
                if (col.IsViewable) { if (viewColumns.Contains(col.Name)) scalarsPresent++; }
                else if (viewColumns.Contains(col.Name)) offenders.Add($"{table}.{col.Name}");
            }
        }

        Assert.Empty(offenders);
        Assert.True(scalarsPresent > 0, "Positive control: viewable scalars must actually be present.");
    }

    [Fact]
    public void GrupTimestamps_AreAbsentFromSchemaAndViewsAlike()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        string[] timestamps = ["timestamp", "temporary_timestamp", "persistent_timestamp"];

        foreach (var table in (string[])["cell", "dial", "qust"])
        {
            var schemaNames = schemas[table].RecordColumns.Select(c => c.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var viewNames = ColumnsOf(table).ToHashSet(StringComparer.OrdinalIgnoreCase);

            Assert.True(viewNames.Count > 6, $"Positive control: {table}'s view must have real columns.");
            foreach (var t in timestamps)
            {
                Assert.DoesNotContain(t, schemaNames);
                Assert.DoesNotContain(t, viewNames);
            }
        }
    }
}
